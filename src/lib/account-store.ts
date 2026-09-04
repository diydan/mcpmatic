// Storage keys keep the old prefix on purpose: renaming this one orphans
// every account that already holds a grant list, and the key is never shown.
import { isSessionToken } from "../../shared/session-token";

const KEY = "mcpmatic.accountId";

type MinimalStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function isWellFormed(value: string | null): value is string {
  // Account ids share the 64-hex-char shape with session tokens; the
  // single regex source of truth is `shared/session-token.ts`.
  return value !== null && isSessionToken(value);
}

/**
 * The console's durable identity.
 *
 * 256 bits of randomness kept in localStorage. It is a bearer credential of
 * the same class as the session token in the URL — whoever has it can inherit
 * the grants it carries — which is the deliberate trade for keeping "no login,
 * no key, no install" true while consent outlives a two-hour session.
 *
 * Returns null when storage is unavailable (private browsing, blocked site
 * data). No account is not an error: the session still works, its grants just
 * die with it, which is exactly the behaviour before accounts existed.
 */
export function ensureAccountId(storage: MinimalStorage): string | null {
  try {
    const existing = storage.getItem(KEY);
    if (isWellFormed(existing)) return existing;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    storage.setItem(KEY, id);
    return id;
  } catch {
    return null;
  }
}

/**
 * Take on the account a passkey login named.
 *
 * This is the whole point of the passkey: on a second browser, or after
 * storage is cleared, the id is not the one holding the
 * grants. Adopting replaces it. A malformed id is refused rather than allowed
 * to overwrite a working one.
 */
export function adoptAccountId(
  storage: MinimalStorage,
  id: string,
): boolean {
  if (!isWellFormed(id)) return false;
  try {
    storage.setItem(KEY, id);
    return true;
  } catch {
    return false;
  }
}

export function accountId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return ensureAccountId(localStorage);
}

/**
 * Bind the open session to the console's account, after a fresh WebAuthn
 * assertion proves the operator controls an authenticator registered to that
 * account.
 *
 * The session URL alone is a bearer credential — whoever has it can claim
 * any account — so the bare POST /s/<token>/account no longer accepts an
 * `accountId` without a step-up token. The token is minted by
 * /account/passkey/step-up/verify only when the assertion is from a
 * credential on file for that account, and only bound to the session whose
 * token the caller already holds. A forged token, a token from another
 * account, or a token bound to a different session is rejected by the DO.
 *
 * Returns `{ ok, consent? }` on success. On any failure the caller learns
 * nothing more than the error string — the response carries no token and no
 * grants, so a console that lost its session URL cannot probe for one.
 */
export async function claimWithStepUp(
  sessionToken: string,
  accountId: string,
): Promise<{ ok: true; consent: string[] } | { ok: false; error: string }> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.credentials?.get !== "function"
  ) {
    return { ok: false, error: "no passkey support" };
  }
  let stepUpToken: string;
  try {
    stepUpToken = await runStepUp(sessionToken, accountId);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "step-up failed",
    };
  }
  const res = await fetch(`/s/${sessionToken}/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId, stepUpToken }),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: unknown;
    consent?: unknown;
    error?: unknown;
  } | null;
  if (!res.ok || !body || body.ok !== true) {
    return {
      ok: false,
      error:
        typeof body?.error === "string"
          ? body.error
          : `claim failed (${res.status})`,
    };
  }
  const consent = Array.isArray(body.consent)
    ? body.consent.filter((x): x is string => typeof x === "string")
    : [];
  return { ok: true, consent };
}

/**
 * The two-call WebAuthn ceremony that mints a step-up token.
 *
 * `step-up/options` returns the standard `PublicKeyCredentialRequestOptions`
 * (challenge, rpId, allowCredentials, userVerification) with the binding to
 * {sessionToken, accountId} hidden inside the challenge record. `navigator.
 * credentials.get` signs the challenge on the user's authenticator, which is
 * what we hand back in `step-up/verify` for the worker to validate. On
 * success the worker returns the step-up token; on failure it returns an
 * error string. The token is single-use and 5-minute TTL; the worker refuses
 * to mint one if the credential is not on file for the account, so a user
 * without a passkey on this account cannot get past the options step.
 */
async function runStepUp(
  sessionToken: string,
  accountId: string,
): Promise<string> {
  const optionsRes = await fetch("/account/passkey/step-up/options", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionToken, accountId }),
  });
  const options = (await optionsRes.json().catch(() => null)) as {
    challenge?: unknown;
    rpId?: unknown;
    allowCredentials?: unknown;
  } | null;
  if (!optionsRes.ok || !options) {
    throw new Error("step-up options failed");
  }
  if (
    typeof options.challenge !== "string" ||
    typeof options.rpId !== "string" ||
    !Array.isArray(options.allowCredentials)
  ) {
    throw new Error("step-up options malformed");
  }
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: base64urlToBytes(options.challenge),
      rpId: options.rpId,
      allowCredentials: options.allowCredentials.map(
        (c): { id: Uint8Array<ArrayBuffer>; type: "public-key" } => ({
          id: base64urlToBytes(c.id),
          type: "public-key",
        }),
      ),
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("step-up cancelled");
  const verifyRes = await fetch("/account/passkey/step-up/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionToken,
      accountId,
      response: cred.toJSON(),
    }),
  });
  const verified = (await verifyRes.json().catch(() => null)) as {
    stepUpToken?: unknown;
    error?: unknown;
  } | null;
  if (!verifyRes.ok || !verified || typeof verified.stepUpToken !== "string") {
    throw new Error(
      typeof verified?.error === "string" ? verified.error : "step-up verify failed",
    );
  }
  return verified.stepUpToken;
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  // Explicit ArrayBuffer-backed (not ArrayBufferLike): WebAuthn types reject
  // the SharedArrayBuffer form, so the helper here matches what the spec asks
  // for rather than what `new Uint8Array(binary.length)` infers.
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}