/**
 * An account is what makes consent outlive a session.
 *
 * A session is a runtime — one Chromium, a two-hour TTL, disposable. Granted
 * origins currently live in that session's `meta` table, so "holds your
 * consent" is true for one afternoon. The account is the durable side: a new
 * session inherits its grants instead of starting empty.
 *
 * Sessions are *claimed*, never replaced. A capability URL with no account
 * behind it is still a working session, which is what keeps "no login, no key,
 * no install" true for anyone who does not want one.
 */
import { isSessionToken } from "../shared/session-token";

export type ClaimDecision =
  | { ok: true }
  | { ok: false; reason: "claimed-by-another" | "no-account" };

/**
 * First claim wins.
 *
 * The session token is a bearer credential, so anyone holding it could try to
 * bind it to an account of their own and inherit whatever it has been granted.
 * Re-claiming by the holder is idempotent — a console reload must not strand a
 * working session.
 */
export function claimDecision(
  currentAccountId: string | null,
  incomingAccountId: string,
): ClaimDecision {
  if (!incomingAccountId) return { ok: false, reason: "no-account" };
  if (currentAccountId === null) return { ok: true };
  if (currentAccountId === incomingAccountId) return { ok: true };
  return { ok: false, reason: "claimed-by-another" };
}

/**
 * An account id is a 256-bit random value the console generates and keeps.
 *
 * It is a bearer credential of the same class as the session token in the
 * capability URL: whoever holds it can bind a session to that account and
 * inherit its grants. That is the deliberate trade for "no login, no key, no
 * install" — durable consent without an auth system, on the same trust
 * footing the product already has. A passkey binding it to an authenticator
 * is what makes it survive cleared storage and reach a second device; until
 * then, unguessability is the whole defence, so the length is load-bearing.
 *
 * Account ids share the 64-hex-char shape with session tokens, so the
 * recognition regex is the same single source of truth. A DO name is compared
 * verbatim, so a token shape that folded case would make two ids resolve to
 * one account — `isSessionToken` is intentionally case-insensitive on hex,
 * and the storage layer is what stops two different hex strings from naming
 * the same Durable Object.
 */
export function isAccountId(value: unknown): value is string {
  return isSessionToken(value);
}
