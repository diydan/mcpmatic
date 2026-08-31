/**
 * SSRF guard for the browser-mcp worker's `navigate` tool.
 *
 * Threat model (06-05 review finding H4): an attacker coerces the
 * Playwright browser to navigate to an internal IP via a classic
 * DNS-rebind attack. The attacker controls the authoritative nameserver
 * for `evil.example.com`; it returns a public IP for the first TTL
 * window (so a hostname-string check passes), then a private IP (e.g.
 * 127.0.0.1) for the second window (so the browser pivots to the
 * internal network).
 *
 * The original guard at apps/workers/browser-mcp/src/index.ts:96-105
 * inspected only the hostname *string*. The replacement resolves the
 * hostname to its actual IP(s) via a `resolve4(hostname)` function —
 * originally the Cloudflare Workers `[[unsafe.bindings]] type =
 * "resolve4"` runtime binding (see coordination/cf-bindings-runbook.md
 * Section 3.2), now a Cloudflare DoH wrapper at `./doh-resolve4.ts`
 * (the unsafe binding required an account-level dashboard opt-in that
 * the operator could not find; see
 * [[project_browser_mcp_10021_unsafe_bindings_toggle]]). The TOCTOU
 * window is unchanged across both mechanisms — see "Known limitation"
 * below.
 *
 * The function is fail-closed: if the resolve4 call throws or returns
 * an empty array, the URL is rejected. The rationale: if we cannot
 * prove the URL is safe, we must assume it is not. This mirrors the
 * H1 Twilio fail-closed pattern (apps/backend/src/app/api/webhooks/
 * twilio/sms/route.ts:51-56) and the H3 meet-bot URL-validation
 * pattern (apps/meeting-bots/meet-bot-container/src/url-allowlist.ts:
 * 400-441).
 *
 * The function is intentionally decoupled from the worker's full `Env`
 * interface — it takes only the `resolve4` function it needs. This
 * makes the unit test trivial (a plain `vi.fn()` for the binding) and
 * keeps the function reusable by any future browser-mcp caller.
 *
 * Known limitation: the canonical DNS-rebind attack relies on a
 * TTL-bounded flip between the guard-time lookup and the fetch-time
 * lookup. A unit test cannot model the time dimension; the rebind
 * scenario in the test exercises the "attacker has pre-warmed the DNS
 * to a private IP by guard-time" case (the realistic scenario for a
 * motivated attacker). True TOCTOU close happens at the browser/SNI
 * layer, not the Worker.
 *
 * PRIVATE_IP_PATTERNS is the same regex list that lived in src/index.ts
 * before the H4 refactor. The H3 sub-plan copy-pasted the same list
 * with attribution (apps/meeting-bots/meet-bot-container/src/
 * url-allowlist.ts:354-364) for the same reason: extracting to a shared
 * module is a follow-up cleanup, not a security-fix blast radius.
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

/**
 * Re-export the resolve4 type alias from the implementation module so
 * callers that historically imported `Resolve4` from `./is-private-url`
 * keep working. The canonical declaration is in `./doh-resolve4.ts`.
 */
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
