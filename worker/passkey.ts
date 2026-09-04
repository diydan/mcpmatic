import type { WebAuthnCredential } from "@simplewebauthn/server";
import { base64urlNoPad, base64urlToBytes } from "./oauth/encoding";

/**
 * Passkeys bind an account to an authenticator.
 *
 * Without one, the account id is a random value in the console's
 * localStorage — durable enough to outlive a session, but lost when storage is
 * cleared and unreachable from a second device. A discoverable credential
 * carries the account id back as its `userHandle`, so a passkey login needs no
 * username and hands the console the account it already had.
 *
 * The authenticator lives on the user's own device and the ceremony is
 * first-party, which is why this works here at all: the README's caveat is
 * about logging in to a *remote site* through a browser in Cloudflare's
 * network, which is a different thing entirely.
 */

/** The relying party is this worker's hostname. Null if the url is unusable. */
export function rpIdFor(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export type StoredCredential = {
  id: string;
  /** base64url — the row is text and the key is bytes. */
  publicKey: string;
  counter: number;
  transports?: string[];
};

export function toStoredCredential(c: WebAuthnCredential): StoredCredential {
  return {
    id: c.id,
    publicKey: base64urlNoPad(c.publicKey),
    counter: c.counter,
    transports: c.transports ? [...c.transports] : undefined,
  };
}

export function fromStoredCredential(s: StoredCredential): WebAuthnCredential {
  return {
    id: s.id,
    publicKey: base64urlToBytes(s.publicKey),
    counter: s.counter,
    transports: s.transports as WebAuthnCredential["transports"],
  };
}
