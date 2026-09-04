/**
 * MCP auth bridge — translate a Bearer token presented at /mcp into the
 * underlying session token that the SessionDO understands.
 *
 * The bearer at /mcp is one of two shapes, both accepted:
 *
 *   - A 64-hex session token, pasted directly into the MCP server config
 *     by ChatGPT or Claude. The bearer IS the session.
 *   - A 43-char base64url access token minted at /oauth/token (RFC 6749
 *     §4.2.2 / RFC 7515 "compact JWS-like" shape). The access token —
 *     when presented to /mcp — must resolve to the same session token
 *     the user originally consented with. Constraint #10 says bearer-token
 *     auth stays; this module is the bridge that keeps /mcp
 *     backwards-compatible while also accepting the new shape.
 *
 * Disambiguation order (intentional, see ledger post-Task 7):
 *
 *   1. 64 hex chars (case-insensitive) — session token, pass through.
 *      We never reach for KV in this branch: the session token IS the
 *      bearer.
 *   2. 43 base64url chars — plausibly an OAuth access token minted at
 *      /oauth/token. We do NOT validate the token shape more strictly
 *      than the regex — KV lookup is the truth. If KV returns null,
 *      KV garbage, or a token whose expiresAt has passed, we return
 *      null and the /mcp handler will turn that into a 401.
 *   3. Anything else — return null.
 *
 * `expiresAt` is a SECOND-LINE defense. KV's `expirationTtl` (Task 7)
 * is the primary enforcement: KV removes the entry once the TTL elapses,
 * so `OAUTH_TOKENS.get` will return null and we never even see an
 * expired blob. The explicit `Date.now() >= tok.expiresAt` check is a
 * belt-and-braces guard for the case where a maintainer changes
 * `expirationTtl` without re-issuing tokens — we still refuse to
 * authenticate against a token whose payload says it has expired.
 */
import type { AccessToken } from "./types";
import { isSessionToken } from "../../shared/session-token";

/** RFC 6749 §4.2.2: 256-bit random access tokens encoded as 43-char base64url (no padding). */
const OAUTH_TOKEN_RE = /^[A-Za-z0-9\-_]{43}$/;

export async function resolveMcpToken(token: string, env: Env): Promise<string | null> {
  // Branch 1 — Phase 1 session token. No I/O. The session token is the
  // bearer; SessionDO.getByName(token) is what /mcp will hand it to next.
  if (isSessionToken(token)) return token;

  // Branch 2 — OAuth access token shape. KV is the source of truth.
  if (OAUTH_TOKEN_RE.test(token)) {
    let tokJson: string | null;
    try {
      tokJson = await env.OAUTH_TOKENS.get(`token:${token}`);
    } catch {
      // KV outages are rare and we do not want a transient infrastructure
      // hiccup to escalate into a leaked error path. Treat as "no token".
      return null;
    }
    if (!tokJson) return null;

    let tok: AccessToken;
    try {
      tok = JSON.parse(tokJson) as AccessToken;
    } catch {
      // Garbage in KV (e.g. a partial write, or someone hand-edited a key).
      // Returning null keeps the request unauthenticated rather than 500ing.
      return null;
    }

    // Second-line defense — see the file-level comment.
    if (typeof tok.expiresAt !== "number" || Date.now() >= tok.expiresAt) {
      return null;
    }

    if (typeof tok.userSessionToken !== "string" || tok.userSessionToken.length === 0) {
      return null;
    }

    return tok.userSessionToken;
  }

  // Branch 3 — anything else is not a bearer we recognize.
  return null;
}
