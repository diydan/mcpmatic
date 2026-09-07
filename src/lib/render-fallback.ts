/**
 * "A page always renders" (spec §6), backstop half.
 *
 * The primary mechanism is the agent: its first tool call on a task is a
 * navigation, so a live page appears as soon as the model responds. This
 * covers the case where that does not happen — no model configured, a model
 * that stalls, a navigation that fails.
 *
 * It deliberately declines to guess. If there is no recent site, it does
 * nothing and the viewport keeps its standby message, because inventing a
 * destination from the task text is pinning through the back door — the thing
 * unpinning the chips was meant to remove.
 *
 * Pure, so the decision is testable without rendering React. Same reason as
 * `shared/consent-ux.ts`.
 */

/** How long to wait for the agent before forcing a render. A starting value, not a measured one. */
export const RENDER_FALLBACK_MS = 8_000;

export type FallbackDecision =
  | { kind: "none" }
  | { kind: "navigate"; origin: string };

export function renderFallbackDecision(args: {
  /** Frames received from the remote browser so far. Non-zero means a page is on screen. */
  framesSeen: number;
  /** True once the fallback has already run; it fires at most once per session. */
  fallbackFired: boolean;
  /** Most-recent-first, as `getRecentSites()` returns them. */
  recent: readonly { origin: string }[];
}): FallbackDecision {
  if (args.framesSeen > 0 || args.fallbackFired) return { kind: "none" };
  const first = args.recent.find((r) => typeof r.origin === "string" && r.origin);
  return first ? { kind: "navigate", origin: first.origin } : { kind: "none" };
}
