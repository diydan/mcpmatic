/**
 * Salted SHA-256 primitives for hashing an OAuth `client_secret`.
 *
 * Per the 2026-09-04 review (DSRV-L1, DSRV-L2): the previous design stored
 * the `client_secret` in plaintext on `OAuthClientDO` and compared it with
 * `!==`, which is neither constant-time nor privacy-preserving. We now hash
 * on persist and verify with a constant-time compare on a per-account salt.
 *
 * The salt is the `clientId` — it is already unique (a v4 UUID per
 * registration) and is stored alongside the hash. Using a per-account salt
 * means a DO data dump reveals only SHA-256 digests that are useless
 * without the corresponding `clientId`.
 *
 * SHA-256 is sufficient here because the secret is itself 256 bits of
 * random entropy — there is no human password and so no rainbow-table /
 * dictionary-attack surface. SHA-256 over `salt:secret` makes the stored
 * hash uninteresting on its own.
 *
 * The wire format is `sha256:<hex>` so the storage shape is self-describing
 * and so we can refuse to verify anything that does not match that prefix
 * (the constant-time compare is done on equal-length hex strings only).
 */

const ENC = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(message: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", ENC.encode(message));
  return hex(buf);
}

/**
 * Hash a plaintext client_secret under a per-client salt.
 *
 * Returns a self-describing `sha256:<hex>` string suitable for direct
 * storage on `OAuthClient.clientSecretHash`.
 */
export async function hashSecret(plain: string, salt: string): Promise<string> {
  return `sha256:${await sha256Hex(`${salt}:${plain}`)}`;
}

/**
 * Constant-time verification of a plaintext secret against a stored
 * `sha256:<hex>` hash using the same per-client salt.
 *
 * Returns false on any malformed stored value (missing prefix, wrong
 * length) — the constant-time compare runs only on equal-length hex
 * strings.
 */
export async function verifySecret(
  plain: string,
  stored: string,
  salt: string,
): Promise<boolean> {
  if (!stored.startsWith("sha256:")) return false;
  const expected = stored.slice("sha256:".length);
  const got = await sha256Hex(`${salt}:${plain}`);
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  }
  return diff === 0;
}
