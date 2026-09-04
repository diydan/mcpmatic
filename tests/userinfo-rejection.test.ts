/**
 * @vitest-environment node
 *
 * Credentials in a navigation URL (2026-09-04 review, M5).
 *
 * `https://user:pass@victim.example/` passes the SSRF guard — that guard
 * classifies the *host*, and the host here is ordinary — but the page then
 * loads with credentials the address bar renders, a misconfigured Referer
 * forwards, and the CDP screencast stores verbatim in the frame metadata.
 * Every tool path that ends in `page.goto` must refuse it before the
 * browser is asked to navigate.
 *
 * Note on placement: this is deliberately NOT a case in `ssrf.test.ts`.
 * `isPrivateUrl` answers "does this hostname resolve to a private address",
 * and `user:pass@example.com` resolves to a public one — asking it to
 * report `true` here would mean overloading a hostname/IP classifier with
 * a credential-hygiene rule. The check belongs at the navigation site, so
 * the test drives the navigation site.
 *
 * SessionDO extends `DurableObject` from `cloudflare:workers`, which the
 * Node test environment cannot resolve; the base class is stubbed, and
 * `ctx.storage.sql` is backed by `node:sqlite` — same harness as
 * session-do-consent.test.ts.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.stubGlobal(
  "WebSocketRequestResponsePair",
  class {
    constructor(
      public request: string,
      public response: string,
    ) {}
  },
);

import { SessionDO } from "../worker/session-do";

function makeSql() {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare: (q: string) => {
        all: (...p: unknown[]) => Array<Record<string, unknown>>;
        run: (...p: unknown[]) => unknown;
      };
    };
  };
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query: string, ...params: unknown[]) => {
      const stmt = db.prepare(query);
      const isRead = /^\s*(SELECT|PRAGMA)/i.test(query);
      if (isRead) {
        const rows = params.length ? stmt.all(...params) : stmt.all();
        return { toArray: () => rows.map((r) => ({ ...r })) };
      }
      if (params.length) stmt.run(...params);
      else stmt.run();
      return { toArray: () => [] };
    },
  };
}

type Harness = {
  do_: SessionDO;
  goto: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
};

/**
 * A session with one consented origin and a page already open on it, so a
 * refusal in these tests can only come from the URL itself — not from the
 * consent gate, and not from a missing browser.
 */
async function makeHarness(): Promise<Harness> {
  const sql = makeSql();
  const ctx = {
    storage: { sql, transactionSync: (cb: () => void) => cb() },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: (cb: () => Promise<void>) => cb(),
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn(() => []),
  };
  const env = { ACCOUNT: { getByName: vi.fn() }, MANIFEST_REGISTRY: undefined };
  const do_ = new SessionDO(
    ctx as unknown as Parameters<typeof SessionDO>[0],
    env as unknown as Parameters<typeof SessionDO>[1],
  );
  await do_.initSession("t".repeat(64));
  sql.exec(
    `INSERT INTO meta (key, value) VALUES ('consent', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(["https://example.com"]),
  );
  const goto = vi.fn(async () => undefined);
  const evaluate = vi.fn(async () => undefined);
  // ensureBrowser short-circuits on an already-live browser, so this stands
  // in for Chromium without a Browser Rendering binding.
  (do_ as unknown as { live: unknown }).live = {
    browser: { close: async () => {} },
    page: {
      goto,
      url: () => "https://example.com/",
      title: async () => "",
      innerText: async () => "",
      evaluate,
      context: () => ({}),
    },
  };
  return { do_, goto, evaluate };
}

const WITH_CREDENTIALS = "https://user:pass@example.com/other";

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "WebSocketRequestResponsePair",
    class {
      constructor(
        public request: string,
        public response: string,
      ) {}
    },
  );
});

describe("navigation refuses URL userinfo", () => {
  it("navigate_to refuses a user:pass@ URL without navigating", async () => {
    const { do_, goto } = await makeHarness();
    const res = await do_.callTool("navigate_to", { url: WITH_CREDENTIALS });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("credentials-in-url");
    expect(goto).not.toHaveBeenCalled();
  });

  it("navigate_to refuses a username-only URL", async () => {
    const { do_, goto } = await makeHarness();
    const res = await do_.callTool("navigate_to", {
      url: "https://admin@example.com/",
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("credentials-in-url");
    expect(goto).not.toHaveBeenCalled();
  });

  it("call_remote_tool refuses a user:pass@ origin without navigating", async () => {
    const { do_, goto, evaluate } = await makeHarness();
    const res = await do_.callTool("call_remote_tool", {
      origin: WITH_CREDENTIALS,
      name: "search",
      arguments: {},
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("credentials-in-url");
    expect(goto).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("a credential-free URL is refused by the SSRF guard instead, not by this check", async () => {
    const { do_, goto } = await makeHarness();
    // DoH answers a private address, so the existing guard is what stops
    // this one — proving the credentials check is not refusing everything.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              Status: 0,
              Answer: [{ name: "example.com.", type: 1, TTL: 300, data: "10.0.0.1" }],
            }),
            { status: 200, headers: { "content-type": "application/dns-json" } },
          ),
      ),
    );
    const res = await do_.callTool("navigate_to", { url: "https://example.com/x" });
    expect(res.ok).toBe(false);
    expect(res.text).toBe("navigation refused (ssrf)");
    expect(goto).not.toHaveBeenCalled();
  });
});
