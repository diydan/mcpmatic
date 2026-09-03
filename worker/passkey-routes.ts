import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isAccountId } from "./account";
import { base64urlToBytes } from "./oauth/encoding";
import {
  fromStoredCredential,
  rpIdFor,
  toStoredCredential,
} from "./passkey";
import { putChallenge, takeChallenge } from "./passkey-challenge";

const RP_NAME = "mcpmatic";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // A ceremony response is never cacheable and never a referrer source.
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * The four WebAuthn ceremony endpoints.
 *
 * Registration binds an authenticator to an account the console already has.
 * Login goes the other way: a discoverable credential returns the account id
 * as its `userHandle`, so there is no username to type and no account to name
 * before the assertion arrives.
 */
export async function handlePasskey(
  request: Request,
  env: Env,
  sub: string,
): Promise<Response> {
  const rpID = rpIdFor(request.url);
  if (!rpID) return json({ error: "bad request" }, 400);
  const origin = new URL(request.url).origin;
  if (request.method !== "POST") return json({ error: "not found" }, 404);

  if (sub === "register/options") {
    const body = (await readJson(request)) as { accountId?: unknown };
    if (!isAccountId(body?.accountId)) {
      return json({ error: "invalid accountId" }, 400);
    }
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: RP_NAME,
      // The account id *is* the user handle, which is what makes a login
      // discoverable: the authenticator hands it back and we know whose it is.
      userID: utf8(body.accountId),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
      },
    });
    await putChallenge(env.OAUTH_TOKENS, options.challenge, {
      kind: "register",
      accountId: body.accountId,
    });
    return json(options);
  }

  if (sub === "register/verify") {
    const body = (await readJson(request)) as {
      response?: RegistrationResponseJSON;
    };
    const challenge = challengeFromClientData(body?.response?.response?.clientDataJSON);
    if (!challenge) return json({ error: "invalid response" }, 400);
    const record = await takeChallenge(env.OAUTH_TOKENS, challenge);
    if (!record || record.kind !== "register") {
      return json({ error: "unknown challenge" }, 400);
    }
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: body.response!,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch {
      return json({ error: "verification failed" }, 400);
    }
    if (!verified.verified || !verified.registrationInfo) {
      return json({ error: "verification failed" }, 400);
    }
    await env.ACCOUNT.getByName(record.accountId).addCredential(
      toStoredCredential(verified.registrationInfo.credential),
    );
    return json({ ok: true });
  }

  if (sub === "login/options") {
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
    });
    await putChallenge(env.OAUTH_TOKENS, options.challenge, { kind: "login" });
    return json(options);
  }

  if (sub === "login/verify") {
    const body = (await readJson(request)) as {
      response?: AuthenticationResponseJSON;
    };
    const response = body?.response;
    const challenge = challengeFromClientData(response?.response?.clientDataJSON);
    if (!response || !challenge) return json({ error: "invalid response" }, 400);
    const record = await takeChallenge(env.OAUTH_TOKENS, challenge);
    if (!record || record.kind !== "login") {
      return json({ error: "unknown challenge" }, 400);
    }
    const accountId = accountFromUserHandle(response.response.userHandle);
    if (!accountId) return json({ error: "no account" }, 400);
    const account = env.ACCOUNT.getByName(accountId);
    const stored = await account.getCredential(response.id);
    if (!stored) return json({ error: "unknown credential" }, 400);
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: fromStoredCredential(stored),
      });
    } catch {
      return json({ error: "verification failed" }, 400);
    }
    if (!verified.verified) return json({ error: "verification failed" }, 400);
    await account.setCredentialCounter(
      stored.id,
      verified.authenticationInfo.newCounter,
    );
    // The account id is what the console needed; it stores it and claims its
    // session with it, exactly as it would one it generated itself.
    return json({ ok: true, accountId });
  }

  return json({ error: "not found" }, 404);
}

/** ArrayBuffer-backed, which is what the WebAuthn types require. */
function utf8(value: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(value.length * 3));
  const { written } = new TextEncoder().encodeInto(value, out);
  return out.slice(0, written) as Uint8Array<ArrayBuffer>;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * The challenge the client actually signed, read back out of clientDataJSON.
 *
 * Taken from the response rather than from a cookie or a session: it is the
 * lookup key for the record we stored, and `verify*Response` then checks that
 * the signed challenge matches what we pass as `expectedChallenge`. A forged
 * value finds no record.
 */
function challengeFromClientData(clientDataJSON: string | undefined): string | null {
  if (!clientDataJSON) return null;
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64urlToBytes(clientDataJSON)),
    ) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

function accountFromUserHandle(userHandle: string | undefined): string | null {
  if (!userHandle) return null;
  try {
    const decoded = new TextDecoder().decode(base64urlToBytes(userHandle));
    return isAccountId(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
