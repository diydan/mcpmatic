import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { adoptAccountId } from "./account-store";

/**
 * The console's half of the WebAuthn ceremonies.
 *
 * Registration binds an authenticator to the account this browser already
 * has. Login goes the other way and hands back whichever account the passkey
 * names, which is what makes the account reachable from a second device or
 * after storage is cleared.
 *
 * Both return a plain result rather than throwing: a user who cancels the
 * system prompt has not hit an error, and the console should say so calmly.
 */
export type PasskeyResult =
  | { ok: true; accountId?: string }
  | { ok: false; message: string };

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(detail?.error ?? `request failed (${res.status})`);
  }
  return res.json();
}

export function passkeysAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined"
  );
}

export async function registerPasskey(accountId: string): Promise<PasskeyResult> {
  try {
    const options = (await postJson("/account/passkey/register/options", {
      accountId,
    })) as Parameters<typeof startRegistration>[0]["optionsJSON"];
    const response = await startRegistration({ optionsJSON: options });
    await postJson("/account/passkey/register/verify", { response });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: message(err) };
  }
}

export async function signInWithPasskey(): Promise<PasskeyResult> {
  try {
    const options = (await postJson(
      "/account/passkey/login/options",
      {},
    )) as Parameters<typeof startAuthentication>[0]["optionsJSON"];
    const response = await startAuthentication({ optionsJSON: options });
    const verified = (await postJson("/account/passkey/login/verify", {
      response,
    })) as { accountId?: unknown };
    if (typeof verified.accountId !== "string") {
      return { ok: false, message: "no account returned" };
    }
    if (typeof localStorage === "undefined") {
      return { ok: false, message: "storage unavailable" };
    }
    if (!adoptAccountId(localStorage, verified.accountId)) {
      return { ok: false, message: "could not store the account" };
    }
    return { ok: true, accountId: verified.accountId };
  } catch (err) {
    return { ok: false, message: message(err) };
  }
}

function message(err: unknown): string {
  if (err instanceof Error) {
    // The user dismissing the system prompt is a decision, not a failure.
    if (err.name === "NotAllowedError") return "passkey cancelled";
    return err.message;
  }
  return "passkey failed";
}
