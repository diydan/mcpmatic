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
import { parseIp } from "../shared/net";

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

  // Ask the question the threat is actually about.
  //
  // This used to require the two resolutions to be identical, in both
  // directions. That is a proxy for "the record did not change", and it is
  // the wrong proxy: CDNs rotate addresses constantly, so a public-to-public
  // rotation — an ordinary load-balanced site — was refused as an attack.
  // Together with the TTL floor it made most of the web unreachable.
  //
  // The rebind we fear is a pivot *inward*: public at guard time, private at
  // fetch time. So both resolutions are checked for the property that
  // matters. A flip into private space is still caught, at whichever
  // resolution sees it, and a flip between two public addresses is allowed —
  // the browser reaches a public host either way, which it could have done
  // by being handed that address directly.
  for (const record of [...first, ...second] as ResolvedRecord[]) {
    const ip = parseIp(record.ip);
    if (!ip) return { ok: false, reason: `unparseable address: ${record.ip}` };
    if (ip.isPrivate || ip.isLoopback || ip.isLinkLocal) {
      return { ok: false, reason: `private address in resolution: ${record.ip}` };
    }
  }
  return { ok: true };
}