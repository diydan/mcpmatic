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
 */

export const PRIVATE_IP_PATTERNS: readonly RegExp[] = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^127\./,
  /^0\./,
  /^::1$/,
  /^f[cd]/,
  /^fe80:/,
];

export const BLOCKED_HOSTS: readonly string[] = [
  "metadata.google.internal",
  "metadata.goog",
];

/** Convenience re-export; the canonical declaration is in `./doh-resolve4.ts`. */
import type { Resolve4 } from "./doh-resolve4";
export type { Resolve4 };

/**
 * Returns `true` if the URL is private/internal and should be rejected.
 * Returns `false` if the URL is safe to navigate to.
 *
 * Algorithm:
 * 1. Parse the URL; if it doesn't parse, reject (fail closed).
 * 2. Require http: or https:; reject otherwise.
 * 3. Check BLOCKED_HOSTS; reject if listed.
 * 4. Check PRIVATE_IP_PATTERNS against the hostname *string*; reject
 *    if any pattern matches (the hostname is a private IP literal).
 * 5. Resolve the hostname via `resolve4`; if the call throws or
 *    returns an empty array, reject (fail closed — we cannot prove
 *    the URL is safe).
 * 6. For every resolved IP, check PRIVATE_IP_PATTERNS; reject if any
 *    resolved IP is private. (The attacker controls all A records; one
 *    poisoned record is enough.)
 * 7. Otherwise, allow.
 */
export async function isPrivateUrl(
  url: string,
  resolve4: Resolve4
): Promise<boolean> {
  // (1) Parse the URL.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  // (2) Protocol allow-list.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }

  // (3) BLOCKED_HOSTS is authoritative — reject even if the resolved
  // IP is public.
  if (BLOCKED_HOSTS.includes(parsed.hostname)) {
    return true;
  }

  // (4) Hostname is a private IP literal (e.g. 127.0.0.1 as the
  // hostname). No DNS resolution needed; the regex check is enough.
  if (PRIVATE_IP_PATTERNS.some((p) => p.test(parsed.hostname))) {
    return true;
  }

  // (5) Resolve the hostname. Fail closed on any error.
  let resolved: string[];
  try {
    resolved = await resolve4(parsed.hostname);
  } catch {
    return true;
  }
  if (!resolved || resolved.length === 0) {
    return true;
  }

  // (6) ANY resolved IP being private → reject. The attacker controls
  // all A records; one poisoned record is enough to rebind.
  for (const ip of resolved) {
    if (PRIVATE_IP_PATTERNS.some((p) => p.test(ip))) {
      return true;
    }
  }

  // (7) All resolved IPs are public.
  return false;
}
