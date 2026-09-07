/**
 * Which transcript line a consent grant produces — and, more to the point,
 * that there is exactly one author for it.
 *
 * A single human grant fires two events at this page: `persistConsent`'s POST
 * to `/s/<token>/consent` returns ok, and the DO's `origin_granted` broadcast
 * (source `"user"`) arrives over the bridge. Both used to append
 * `granted <origin>`, so every grant — the address bar, the Consent panel's
 * Grant button, the "or any site" form — printed the same line twice.
 *
 * The broadcast is the author, because it is the only one of the two that
 * fires for both sources and for a grant made in another tab. The local half
 * returns null and appends nothing.
 *
 * Extracted into a pure module so the behaviour is testable without rendering
 * React. Same reason as `shared/consent-ux.ts` and `./render-fallback.ts` —
 * both Finding 1 and Finding 4 of the final review were defects that shipped
 * inside untested client wiring.
 */

import { displayHosts } from "../../shared/origin";

export type GrantEvent =
  /** This page POSTed a grant and the server accepted it. */
  | { kind: "local-grant"; origin: string }
  /** The DO broadcast `origin_granted`. Reaches every socket on the session. */
  | { kind: "broadcast"; origin: string; source: "model" | "user" };

/**
 * The `kind: "system"` line this event should append, or null for none.
 *
 * Feed it every event a grant produces and exactly one line comes back. That
 * is the property the test asserts, and it is the reason both call sites in
 * `Session.tsx` go through here rather than writing their own string.
 */
export function grantTranscriptLine(event: GrantEvent): string | null {
  // The POST's own success is not a transcript event: the broadcast it causes
  // is already on its way to this same socket.
  if (event.kind === "local-grant") return null;
  if (event.source === "model") {
    // Spec §3: an origin the agent picked must be visible as the agent's
    // choice, and visibly session-scoped.
    const host = displayHosts([event.origin]).join("") || event.origin;
    return `Opening ${host} — granted for this session`;
  }
  return `granted ${event.origin}`;
}
