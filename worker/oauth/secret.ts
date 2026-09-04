import { base64urlNoPad } from "./encoding";

/**
 * Salted SHA-256 helper for storing client secrets at rest.
 *
 * Audit finding (#1 in task-1-report.md, §1.2): the OAuthClientDO was
 * persisting `clientSecret` in plaintext, and the token handler did a
 * plain `!==` string compare. Both are fixed here:
 *
 *   - At registration time we generate a fresh 16-byte salt per client,
 *     hash `plaintext + "|" + salt` with SHA-256, and store the digest
 *     plus the salt. The plaintext is echoed back to the caller once
 *     (RFC 7591 §3.2.1 for confidential clients) and discarded.
 *   - At token time we recompute the digest of the presented plaintext
 *     with the stored salt and compare digests in constant time — we
 *     never touch plaintext on disk.
 *
 * SHA-256 (not bcrypt/argon2) is intentional: the secret is 256 bits of
 * CSPRNG entropy, so the threat model is a read-only DO/database breach,
 * not a brute-force preimage search. A slow KDF would not help here and
 * would add a per-request CPU cost on every /token call.
 *
 * Encoding: hex for the hash (matches the rest of the codebase's SHA-256
 * idioms in `pkce.ts`), base64url-no-pad for the salt (matches token
 * encoding in `encoding.ts`).
 */
export async function hashClientSecret(
  plaintext: string,
  salt: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${plaintext}|${salt}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Fresh 16-byte salt, base64url-no-pad (22 chars). */
export function freshSalt(): string {
  return base64urlNoPad(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Constant-time compare on hex-encoded SHA-256 digests. Same shape as
 * `pkce.ts:timingSafeEqual` — kept local because the two callers (PKCE
 * vs. client secret) live in different modules and should not share an
 * import surface that drags the OAuth handler graph into the PKCE test
 * suite (or vice versa).
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
