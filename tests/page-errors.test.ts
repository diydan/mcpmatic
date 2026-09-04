import { describe, expect, it, vi } from "vitest";
import {
  PageErrorLog,
  PAGE_ERROR_LIMIT,
  attachPageErrorCapture,
  describePageErrors,
  type PageEventSource,
} from "../worker/page-errors";

/** A page that records its handlers so a test can fire the events itself. */
function fakePage() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const page: PageEventSource = {
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    }),
  };
  return {
    page,
    fire: (event: string, payload: unknown) => handlers.get(event)?.(payload),
    events: () => [...handlers.keys()],
  };
}

describe("PageErrorLog", () => {
  it("keeps entries oldest first", () => {
    const log = new PageErrorLog();
    log.record({ kind: "console", text: "first" });
    log.record({ kind: "console", text: "second" });
    expect(log.all().map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("drops the oldest past the limit, never the newest", () => {
    const log = new PageErrorLog();
    for (let i = 0; i < PAGE_ERROR_LIMIT + 20; i++) {
      log.record({ kind: "console", text: `e${i}` });
    }
    const all = log.all();
    expect(all).toHaveLength(PAGE_ERROR_LIMIT);
    expect(all[all.length - 1].text).toBe(`e${PAGE_ERROR_LIMIT + 19}`);
    expect(all[0].text).toBe("e20");
  });

  it("truncates text and strips control characters", () => {
    const log = new PageErrorLog();
    log.record({ kind: "console", text: `a\u0000b\u001f${"x".repeat(500)}` });
    const entry = log.all()[0];
    expect(entry.text.length).toBeLessThanOrEqual(300);
    expect(entry.text.startsWith("a b ")).toBe(true);
  });

  it("returns a copy, so a caller cannot mutate the buffer", () => {
    const log = new PageErrorLog();
    log.record({ kind: "console", text: "one" });
    log.all().push({ kind: "console", text: "injected", ts: 0 });
    expect(log.size).toBe(1);
  });

  it("clears", () => {
    const log = new PageErrorLog();
    log.record({ kind: "console", text: "one" });
    log.clear();
    expect(log.all()).toEqual([]);
  });
});

describe("attachPageErrorCapture", () => {
  it("reports false for a page with no event support", () => {
    expect(attachPageErrorCapture({}, new PageErrorLog())).toBe(false);
  });

  it("subscribes to every error channel", () => {
    const { page, events } = fakePage();
    expect(attachPageErrorCapture(page, new PageErrorLog())).toBe(true);
    expect(events().sort()).toEqual(["console", "pageerror", "requestfailed", "response"]);
  });

  it("records an uncaught page error", () => {
    const { page, fire } = fakePage();
    const log = new PageErrorLog();
    attachPageErrorCapture(page, log);
    fire("pageerror", new Error("boom"));
    expect(log.all()[0]).toMatchObject({ kind: "pageerror", text: "boom" });
  });

  it("records console errors and warnings but ignores logs", () => {
    const { page, fire } = fakePage();
    const log = new PageErrorLog();
    attachPageErrorCapture(page, log);
    fire("console", { type: () => "log", text: () => "chatter" });
    fire("console", { type: () => "warning", text: () => "careful" });
    fire("console", { type: () => "error", text: () => "broken" });
    expect(log.all().map((e) => e.text)).toEqual(["careful", "broken"]);
  });

  it("records a failed request with its url", () => {
    const { page, fire } = fakePage();
    const log = new PageErrorLog();
    attachPageErrorCapture(page, log);
    fire("requestfailed", {
      url: () => "https://example.com/api",
      failure: () => ({ errorText: "net::ERR_FAILED" }),
    });
    expect(log.all()[0]).toMatchObject({
      kind: "requestfailed",
      text: "net::ERR_FAILED",
      url: "https://example.com/api",
    });
  });

  it("records a 4xx/5xx response and ignores a healthy one", () => {
    const { page, fire } = fakePage();
    const log = new PageErrorLog();
    attachPageErrorCapture(page, log);
    fire("response", { url: () => "https://example.com/ok", status: () => 200 });
    fire("response", { url: () => "https://example.com/gone", status: () => 404 });
    fire("response", { url: () => "https://example.com/boom", status: () => 500 });
    expect(log.all().map((e) => e.status)).toEqual([404, 500]);
  });

  it("survives a malformed event rather than throwing into the DO", () => {
    const { page, fire } = fakePage();
    const log = new PageErrorLog();
    attachPageErrorCapture(page, log);
    expect(() =>
      fire("console", {
        type: () => {
          throw new Error("bad message");
        },
      }),
    ).not.toThrow();
    expect(log.size).toBe(0);
  });

  it("reports false when subscribing itself throws", () => {
    const page: PageEventSource = {
      on: () => {
        throw new Error("no events on this binding");
      },
    };
    expect(attachPageErrorCapture(page, new PageErrorLog())).toBe(false);
  });
});

describe("describePageErrors", () => {
  it("says so plainly when nothing was recorded", () => {
    expect(describePageErrors([])).toBe("No page errors recorded this session.");
  });

  it("renders kind, url and text", () => {
    const text = describePageErrors([
      { kind: "http", text: "HTTP 500", url: "https://example.com/x", status: 500, ts: 1 },
      { kind: "pageerror", text: "boom", ts: 2 },
    ]);
    expect(text).toContain("2 recorded (newest last)");
    expect(text).toContain("[http] https://example.com/x HTTP 500");
    expect(text).toContain("[pageerror] boom");
  });
});

describe("console/network de-duplication", () => {
  it("drops Chromium's console echo of a failed subresource", () => {
    const { page, fire } = fakePage();
    const log = new PageErrorLog();
    attachPageErrorCapture(page, log);
    fire("response", { url: () => "https://example.com/x.png", status: () => 404 });
    fire("console", {
      type: () => "error",
      text: () => "Failed to load resource: the server responded with a status of 404 (Not Found)",
    });
    // One problem, one entry — and the one that kept the URL.
    expect(log.all()).toHaveLength(1);
    expect(log.all()[0]).toMatchObject({ kind: "http", url: "https://example.com/x.png" });
  });

  it("keeps an ordinary console error", () => {
    const { page, fire } = fakePage();
    const log = new PageErrorLog();
    attachPageErrorCapture(page, log);
    fire("console", { type: () => "error", text: () => "checkout total is NaN" });
    expect(log.all()).toHaveLength(1);
  });
});

describe("defensive handling of malformed events", () => {
  it("ignores a response whose status is not a finite number", () => {
    const { page, fire } = fakePage();
    const log = new PageErrorLog();
    attachPageErrorCapture(page, log);
    // undefined < 400 is false, so a bare range check would record this as
    // an "HTTP undefined" row.
    fire("response", { url: () => "https://example.com/a", status: () => undefined });
    fire("response", { url: () => "https://example.com/b", status: () => NaN });
    fire("response", { url: () => "https://example.com/c" });
    expect(log.all()).toEqual([]);
  });

  it("still records a well-formed error response alongside them", () => {
    const { page, fire } = fakePage();
    const log = new PageErrorLog();
    attachPageErrorCapture(page, log);
    fire("response", { url: () => "https://example.com/a", status: () => undefined });
    fire("response", { url: () => "https://example.com/b", status: () => 503 });
    expect(log.all().map((e) => e.status)).toEqual([503]);
  });
});

describe("buffered entries are not reachable through a read", () => {
  it("copies each entry, not just the array", () => {
    const log = new PageErrorLog();
    log.record({ kind: "console", text: "original" });
    const read = log.all();
    read[0].text = "rewritten";
    read[0].kind = "http";
    expect(log.all()[0]).toMatchObject({ kind: "console", text: "original" });
  });
});
