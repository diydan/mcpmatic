/**
 * Verify a PKCE code_verifier against a stored S256 code_challenge.
 * Returns true iff base64url-no-pad(SHA256(verifier)) === challenge.
 *
 * RFC 7636 §4.6 — verifier is 43-128 chars from [A-Z][a-z][0-9]-._~
 */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const computed = base64urlNoPad(new Uint8Array(digest));
  // Constant-time compare to prevent timing attacks.
  return timingSafeEqual(computed, challenge);
}

function base64urlNoPad(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
