/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  RENDER_FALLBACK_MS,
  renderFallbackDecision,
  renderFallbackEffect,
  type FallbackInput,
} from "../src/lib/render-fallback";

const recent = [{ origin: "https://www.kayak.com" }];

describe("renderFallbackDecision", () => {
  it("does nothing once a frame has arrived", () => {
    // The agent navigated first, as spec §2 requires. Nothing to back up.
    expect(
      renderFallbackDecision({ framesSeen: 1, fallbackFired: false, recent }),
    ).toEqual({ kind: "none" });
  });

  it("navigates to the most recent site when nothing rendered", () => {
    expect(
      renderFallbackDecision({ framesSeen: 0, fallbackFired: false, recent }),
    ).toEqual({ kind: "navigate", origin: "https://www.kayak.com" });
  });

  it("fires at most once", () => {
    // Otherwise a model that never navigates yanks the page back every 8s.
    expect(
      renderFallbackDecision({ framesSeen: 0, fallbackFired: true, recent }),
    ).toEqual({ kind: "none" });
  });

  it("does nothing when there is no recent site to fall back to", () => {
    // Better a standby message than an arbitrary site: guessing a destination
    // is pinning through the back door, which spec §Decisions rejects.
    expect(
      renderFallbackDecision({ framesSeen: 0, fallbackFired: false, recent: [] }),
    ).toEqual({ kind: "none" });
  });

  it("skips a malformed recent entry", () => {
    expect(
      renderFallbackDecision({
        framesSeen: 0,
        fallbackFired: false,
        recent: [{ origin: "" }, { origin: "https://www.gov.uk" }],
      }),
    ).toEqual({ kind: "navigate", origin: "https://www.gov.uk" });
  });

  it("waits long enough for a model turn", () => {
    expect(RENDER_FALLBACK_MS).toBeGreaterThanOrEqual(5_000);
  });
});

/**
 * The render-only contract (spec §6, and the CRITICAL finding of the final
 * review). The fallback opens a page and does nothing else. Before this, its
 * only navigation mechanism was `executeTool(navigate_to, …)`, which routes
 * through `allowOrigin` on the DO — and `allowOrigin` auto-grants. A user with
 * real history got "nothing opened yet — showing your last site, allbirds.com"
 * followed one line later by "Opening allbirds.com — granted for this
 * session", allbirds.com listed granted-with-revoke in the Consent panel, and
 * its tools (`fill_checkout` included) registered on a trip-planning task.
 */
describe("renderFallbackEffect", () => {
  const fired: FallbackInput = {
    framesSeen: 0,
    fallbackFired: false,
    recent,
  };

  function effect(over: Partial<FallbackInput> = {}) {
    return renderFallbackEffect({ ...fired, ...over });
  }

  it("declines wherever the decision declines", () => {
    expect(effect({ framesSeen: 1 })).toEqual({ kind: "none" });
    expect(effect({ fallbackFired: true })).toEqual({ kind: "none" });
    expect(effect({ recent: [] })).toEqual({ kind: "none" });
  });

  it("sends render_fallback, never a navigate_to tool call", () => {
    // `navigate_to` is the mechanism that auto-grants. The fallback must not
    // reach it, directly or through the WebMCP registration.
    const out = effect();
    expect(out.kind).toBe("render-only");
    if (out.kind !== "render-only") return;
    expect(out.message).toEqual({
      v: 1,
      type: "render_fallback",
      origin: "https://www.kayak.com",
    });
    expect(JSON.stringify(out.message)).not.toContain("navigate_to");
    expect(JSON.stringify(out.message)).not.toContain("tool_exec");
  });

  it("offers no way to grant, register tools, or seed consent", () => {
    // A structural assertion on purpose: the effect is the complete set of
    // things the timer may do, so a future field that grants an origin cannot
    // be added without this failing.
    const out = effect();
    if (out.kind !== "render-only") throw new Error("expected an effect");
    expect(Object.keys(out).sort()).toEqual(["kind", "line", "message", "origin"]);
    expect(Object.keys(out.message).sort()).toEqual(["origin", "type", "v"]);
  });

  it("words its line differently from a task origin's", () => {
    // Spec §6: the fallback is the one path that can put a site on screen
    // unrelated to the task, so its line must not be mistakable for the
    // "Connected to ..." wording used for task origins.
    const out = effect();
    if (out.kind !== "render-only") throw new Error("expected an effect");
    expect(out.line).not.toMatch(/Connected to/i);
    expect(out.line).toMatch(/nothing opened yet/i);
  });

  it("never says the origin was granted", () => {
    // The `origin_granted` handler's model wording ("— granted for this
    // session") is exactly what spec §6 forbids for this path.
    const out = effect();
    if (out.kind !== "render-only") throw new Error("expected an effect");
    expect(out.line).not.toMatch(/granted for this session/i);
    expect(out.line).toMatch(/is not granted/i);
  });

  it("says it is opening the site, not that it has shown one", () => {
    // The DO can still refuse the navigation (SSRF, no browser binding). The
    // line is written before the outcome is known, so it must not claim a
    // page that never arrived.
    const out = effect();
    if (out.kind !== "render-only") throw new Error("expected an effect");
    expect(out.line).toMatch(/opening your last site/i);
  });

  it("names the host, not the full origin", () => {
    const out = effect();
    if (out.kind !== "render-only") throw new Error("expected an effect");
    expect(out.line).toContain("kayak.com");
    expect(out.line).not.toContain("https://");
  });

  it("carries the full origin in the message, whatever the line shows", () => {
    // The DO needs a URL it can hand to `goto`; the human needs a host.
    const out = effect({ recent: [{ origin: "https://www.gov.uk" }] });
    if (out.kind !== "render-only") throw new Error("expected an effect");
    expect(out.message.origin).toBe("https://www.gov.uk");
    expect(out.origin).toBe("https://www.gov.uk");
  });
});
