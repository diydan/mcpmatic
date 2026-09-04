/**
 * SSRF guard for every navigation this worker can cause.
 *
 * Threat model: an attacker coerces the remote browser to reach an internal
 * address via a classic DNS-rebind. The attacker controls the authoritative
 * nameserver for `evil.example.com`; it returns a public IP for the first TTL
 * window (so a hostname-string check passes), then a private IP (e.g.
 * 127.0.0.1) for the second window (so the browser pivots inward).
 *
 * A guard that inspects only the hostname *string* does not catch that. This
 * one resolves the hostname to its actual addresses through a `resolve4`
 * function (`./doh-resolve4.ts`) and rejects if any of them is private.
 *
 * The function is fail-closed: if the resolve call throws or returns an empty
 * array, the URL is rejected. If we cannot prove a URL is safe, we assume it
 * is not.
 *
 * It takes only the `resolve4` function it needs rather than the worker `Env`,
 * so the unit test is a plain `vi.fn()`.
 *
 * Known limitation: the canonical rebind attack turns on a TTL-bounded flip
 * between the guard-time lookup and the browser's fetch-time lookup. A unit
 * test cannot model the time dimension; the rebind case in the test exercises
 * "the attacker has already pointed DNS at a private address by guard time",
 * which is the realistic scenario. Truly closing the TOCTOU window would have
 * to happen at the browser/SNI layer, not here.
 *
 * Address parsing lives in `shared/net.ts`. That module handles IPv4
 * dotted-decimal, IPv6 (full, zero-compressed, bracketed, `::ffff:`
 * mapped, `%zone-id`), and exposes a single `parseIp` returning
 * { family, isPrivate, isLoopback, isLinkLocal, isDocumentation }. The
 * previous regex-based check (`PRIVATE_IP_PATTERNS`) missed several
 * canonical forms — see 2026-09-04 review, H1.
 */

import { parseIp, extractHostname } from "../shared/net";

/** Hard rule for these literals — DNS isn't needed and might lie. */
function hostnameIsPrivate(hostname: string): boolean {
  const ip = parseIp(hostname);
  if (!ip) return false;
  // Once mapped IPv4 is normalised by parseIp, the family-4 branch reports
  // loopback/private/link-local directly. For family-6, the loopback and
  // link-local checks are also flags; off-limits.
  return ip.isPrivate || ip.isLoopback || ip.isLinkLocal;
}

export async function isPrivateUrl(
  url: string,
  resolve4: Resolve4,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  if (BLOCKED_HOSTS.includes(parsed.hostname)) return true;

  const hostname = extractHostname(parsed);

  // IP-literal hostnames short-circuit DNS. There's nothing to rebind
  // (the address IS the hostname) and resolving would just add a DoH
  // round-trip — the previous regex-only check implicitly relied on
  // the same property. Any off-limits flag means reject.
  if (hostnameIsPrivate(hostname)) return true;
  const literal = parseIp(hostname);
  if (literal) return false;

  let resolved: string[];
  try {
    resolved = await resolve4(hostname);
  } catch {
    return true;
  }
  if (!resolved || resolved.length === 0) return true;

  for (const ip of resolved) {
    const r = parseIp(ip);
    if (!r) return true;            // an unparseable A/AAAA record is failure
    if (r.isPrivate || r.isLoopback || r.isLinkLocal) return true;
  }
  return false;
}

/** Keep BLOCKED_HOSTS — these are authoritative even if DNS says otherwise. */
export const BLOCKED_HOSTS: readonly string[] = [
  "metadata.google.internal",
  "metadata.goog",
];

/* PRIVATE_IP_PATTERNS removed — see shared/net.ts. */
export type { Resolve4 } from "./doh-resolve4";
import type { Resolve4 } from "./doh-resolve4";
