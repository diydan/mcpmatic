/**
 * Navigation-time re-resolve check. See `session-do.ts` for call sites.
 *
 * Why this exists (Review H2):
 *
 *   The SSRF guard runs `isPrivateUrl` once, when the worker decides to
 *   navigate. A DNS-rebind attacker can satisfy that guard with a public IP
 *   and then flip the record — inside the TTL window — before the browser
 *   fetches it. The browser pivots inward.
 *
 *   Two mitigations live here:
 *
 *   1. `doh-resolve4` refuses DoH answers with TTL < 30 s. The attacker
 *      now has to commit to the answer for at least the navigation
 *      window. (Cheap, but loses a few legitimate short-TTL hosts.)
 *
 *   2. We resolve the hostname twice, ~250 ms apart. If the IP set
 *      differs between the two calls, abort. The TOCTOU window is now
 *      bounded by *both* round trips AND by the attacker's TTL commit —
 *      an attacker who can hold the public answer for 30 s and
 *      perfectly time the flip inside 250 ms is much harder than one
 *      who can just flip on a 50 ms TTL.
 *
 * The 250 ms delay is per-call. Measure twice before proposing a
 * different value — see task-5 report.
 *
 * The resolver is injected so the unit test can drive a stub without a
 * real network. `session-do.ts` passes `makeResolve4Records()`.
 */

import type { ResolvedRecord, Resolve4Records } from "./doh-resolve4";

const RE_RESOLVE_DELAY_MS = 250;

export type NavigationStableResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Resolve once, wait, resolve again. If either resolution is empty or
 * the IP sets differ, abort with a reason string.
 */
export async function navigationStable(
  target: string,
  resolve: Resolve4Records,
): Promise<NavigationStableResult> {
  let hostname: string;
  try {
    hostname = new URL(target).hostname;
  } catch {
    return { ok: false, reason: "unparseable url" };
  }

  const first = await resolve(hostname);
  if (first.length === 0) return { ok: false, reason: "no stable resolution" };

  await new Promise((r) => setTimeout(r, RE_RESOLVE_DELAY_MS));

  const second = await resolve(hostname);
  if (second.length === 0) return { ok: false, reason: "no stable resolution" };

  const firstSet = new Set(first.map((r: ResolvedRecord) => r.ip));
  const secondSet = new Set(second.map((r: ResolvedRecord) => r.ip));

  for (const ip of firstSet) {
    if (!secondSet.has(ip)) {
      return { ok: false, reason: `record flip detected: ${ip}` };
    }
  }
  for (const ip of secondSet) {
    if (!firstSet.has(ip)) {
      return { ok: false, reason: `record flip detected: ${ip}` };
    }
  }
  return { ok: true };
}