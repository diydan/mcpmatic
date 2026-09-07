/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  RENDER_FALLBACK_MS,
  renderFallbackDecision,
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
