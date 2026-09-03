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

/**
 * Inverse of `base64urlNoPad`.
 *
 * `atob` needs the standard alphabet and correct padding, both of which the
 * URL-safe unpadded form strips. Passkey storage needs this: a public key is
 * bytes and a SQLite column is text, so every login decodes what registration
 * encoded — and a padding bug there surfaces only as a signature failure.
 */
export function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  // Explicitly ArrayBuffer-backed, not ArrayBufferLike: WebAuthn's credential
  // type is narrower, and a SharedArrayBuffer would not satisfy it.
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
