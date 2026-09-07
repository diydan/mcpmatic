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
 * It is also render-only. The destination is the user's own last site, which
 * has nothing to do with the task in hand, so it must not join the task's
 * consent set: no grant, no `origin_granted` transcript line, no tools
 * registered for it. `renderFallbackEffect` is what makes that contract
 * checkable — it names the one message the client may send and the one line it
 * may write, and there is no third thing it can do.
 *
 * Pure, so the decision is testable without rendering React. Same reason as
 * `shared/consent-ux.ts`.
 */

import type { ClientMessage } from "../../shared/protocol";
import { displayHosts } from "../../shared/origin";

/** How long to wait for the agent before forcing a render. A starting value, not a measured one. */
export const RENDER_FALLBACK_MS = 8_000;

export type FallbackDecision =
  | { kind: "none" }
  | { kind: "navigate"; origin: string };

/** The only message the fallback is allowed to put on the bridge. */
export type RenderFallbackMessage = Extract<
  ClientMessage,
  { type: "render_fallback" }
>;

export type FallbackEffect =
  | { kind: "none" }
  | {
      kind: "render-only";
      origin: string;
      /** The transcript line to append, as `kind: "system"`. */
      line: string;
      /** The message to send. Never a `tool_exec` of `navigate_to`. */
      message: RenderFallbackMessage;
    };

export type FallbackInput = {
  /** Frames received from the remote browser so far. Non-zero means a page is on screen. */
  framesSeen: number;
  /** True once the fallback has already run; it fires at most once per session. */
  fallbackFired: boolean;
  /**
   * Most-recent-first, as `getStoredRecentSites()` returns them — genuine
   * stored history only. NOT `getRecentSites()`, which falls back to the
   * canned `STORES` list and so would hand a first-time visitor Allbirds:
   * that substitution is the originating bug of this whole branch.
   */
  recent: readonly { origin: string }[];
};

export function renderFallbackDecision(args: FallbackInput): FallbackDecision {
  if (args.framesSeen > 0 || args.fallbackFired) return { kind: "none" };
  const first = args.recent.find((r) => typeof r.origin === "string" && r.origin);
  return first ? { kind: "navigate", origin: first.origin } : { kind: "none" };
}

/**
 * The decision plus everything the client is permitted to do about it.
 *
 * The wording is deliberately not the "Connected to ..." line used for task
 * origins, and deliberately not the "granted for this session" line used for
 * an `origin_granted` broadcast: this origin is neither. It says "opening"
 * rather than "showing" because the DO can still refuse the navigation, and
 * the line must not claim a page that never arrived.
 */
export function renderFallbackEffect(args: FallbackInput): FallbackEffect {
  const decision = renderFallbackDecision(args);
  if (decision.kind === "none") return { kind: "none" };
  const host = displayHosts([decision.origin]).join("") || decision.origin;
  return {
    kind: "render-only",
    origin: decision.origin,
    line: `nothing opened yet — opening your last site, ${host}. It is not part of this task and is not granted.`,
    message: { v: 1, type: "render_fallback", origin: decision.origin },
  };
}
