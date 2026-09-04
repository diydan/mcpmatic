/**
 * The shape of a session capability token.
 *
 * 256 bits of randomness, hex-encoded (lowercase on the wire; the regex
 * accepts uppercase so client-provided strings do not have to normalise case
 * before a route matches them). The token is a bearer credential — whoever
 * holds it can act on the session — so the format is duplicated in every
 * place that recognises one, and this module is the single source of truth.
 *
 * `SESSION_TOKEN_RE` is the anchored form, for `RegExp.test`. Routes that
 * embed the shape inside a larger URL pattern use `SESSION_TOKEN_SOURCE`,
 * which is the body of the regex (no anchors) so it composes cleanly with
 * the surrounding `/...` literals.
 *
 * `isSessionToken` is a type guard: it narrows `unknown` to `string` for the
 * hot path that needs to extract the token from a body before doing anything
 * with it. Both the worker's own regex checks and the console's input
 * validation import from here.
 */
export const SESSION_TOKEN_RE = /^[A-Fa-f0-9]{64}$/;

/** Unanchored body of `SESSION_TOKEN_RE`, for embedding in larger patterns. */
export const SESSION_TOKEN_SOURCE = "[A-Fa-f0-9]{64}";

export function isSessionToken(s: unknown): s is string {
  return typeof s === "string" && SESSION_TOKEN_RE.test(s);
}
