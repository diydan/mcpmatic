/**
 * Encode bytes as base64url without padding (RFC 4648 §5).
 *
 * Used wherever the OAuth code paths need a URL-safe, compact encoding of
 * raw bytes — e.g. the PKCE S256 challenge digest, the dynamic client
 * registration `client_secret`. Imported by `pkce.ts` and `register.ts`
 * so the encoding is defined in exactly one place.
 */
export function base64urlNoPad(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
