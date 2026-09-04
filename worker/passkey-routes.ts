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
import { mintStepUp, putChallenge, takeChallenge } from "./passkey-challenge";
import { consume } from "./rate-limit";
import { isSessionToken } from "../shared/session-token";

const RP_NAME = "BrowserMatic";

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
    // The account comes from the session, never from the request body.
    //
    // An account id is a bearer credential, so a body field would let anyone
    // who learned one attach their own authenticator to it — durable access
    // the owner cannot see and cannot revoke, obtained without ever holding
    // the session. Requiring the capability token means registration proves
    // possession of the same credential the rest of the product rests on, and
    // knowing the account id alone is not enough.
    const body = (await readJson(request)) as { sessionToken?: unknown };
    if (!isSessionToken(body?.sessionToken)) {
      return json({ error: "invalid sessionToken" }, 400);
    }
    let accountId: string | null;
    try {
      // SessionDO.accountForPasskey throws on an expired session; translate
      // to the same 410 the consent routes answer, so a stale token cannot
      // mint a durable passkey bound to whatever account it had claimed.
      ({ accountId } = await env.SESSION.getByName(
        body.sessionToken,
      ).accountForPasskey());
    } catch (err) {
      if (err instanceof Error && err.message === "session expired") {
        return json({ ok: false, error: "session expired" }, 410);
      }
      throw err;
    }
    if (!isAccountId(accountId)) {
      return json({ error: "session has no account" }, 400);
    }
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: RP_NAME,
      // The account id *is* the user handle, which is what makes a login
      // discoverable: the authenticator hands it back and we know whose it is.
      userID: utf8(accountId),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    await putChallenge(env.OAUTH_TOKENS, options.challenge, {
      kind: "register",
      accountId,
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
    // The login ceremony is the only public POST in this router — registration
    // is gated by the session token, so its bucket ceiling is whatever the
    // WAF rule says. login/options is reached by every sign-in attempt and
    // must tolerate retries (a real authenticator only fetches it when the
    // user clicks "sign in", so 30/min is generous); a runaway script that
    // polls it would burn through KV writes without ever presenting an
    // assertion. Cap it before the challenge is minted.
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const rl = await consume(env, "passkey-login-options", ip, {
      limit: 30,
      windowSeconds: 60,
    });
    if (!rl.ok) {
      return json({ error: "rate_limited" }, 429);
    }
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
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

  if (sub === "step-up/options") {
    // Step-up proves a fresh WebAuthn assertion over an authenticator already
    // bound to the account the caller wants to claim, so the assertion
    // cannot be lifted onto a different session or replayed into a different
    // account. The challenge we issue carries the binding; the assertion
    // signs it; the step-up token we mint on success carries the same
    // binding into the /s/<token>/account claim that consumes it.
    //
    // No claim side-effect here: this endpoint exists to issue a ceremony.
    // The `accountId` and `sessionToken` are pure inputs that we *echo back
    // into the KV record*, not anything we look up at the session yet — the
    // session does not even know a step-up is in flight.
    const body = (await readJson(request)) as {
      sessionToken?: unknown;
      accountId?: unknown;
    };
    if (
      !isSessionToken(body?.sessionToken) ||
      typeof body?.accountId !== "string" ||
      !isAccountId(body.accountId)
    ) {
      return json({ error: "invalid input" }, 400);
    }
    const allowCredentials = await env.ACCOUNT
      .getByName(body.accountId)
      .listCredentialsForStepUp();
    // No credentials means no authenticator is registered for this account,
    // and a step-up is not possible. Failing here is friendlier than letting
    // the browser show "no credentials available" — it tells the caller
    // what the next step is (register a passkey first).
    if (allowCredentials.length === 0) {
      return json({ error: "no passkeys on account" }, 400);
    }
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: "required",
    });
    await putChallenge(env.OAUTH_TOKENS, options.challenge, {
      kind: "stepup",
      accountId: body.accountId,
      sessionToken: body.sessionToken,
    });
    return json(options);
  }

  if (sub === "step-up/verify") {
    const body = (await readJson(request)) as {
      sessionToken?: unknown;
      accountId?: unknown;
      response?: AuthenticationResponseJSON;
    };
    const sessionToken = body?.sessionToken;
    const accountId = body?.accountId;
    const response = body?.response;
    if (
      !isSessionToken(sessionToken) ||
      typeof accountId !== "string" ||
      !isAccountId(accountId)
    ) {
      return json({ error: "invalid input" }, 400);
    }
    const challenge = challengeFromClientData(response?.response?.clientDataJSON);
    if (!response || !challenge) return json({ error: "invalid response" }, 400);
    const record = await takeChallenge(env.OAUTH_TOKENS, challenge);
    // Take the challenge *before* we know whether the assertion verifies —
    // single-use is the point, even on a bad assertion, so the same
    // challenge cannot be presented twice.
    if (!record || record.kind !== "stepup") {
      return json({ error: "unknown challenge" }, 400);
    }
    // The challenge carries the binding. A request body that disagrees is
    // either a client bug or a forgery; refuse without verifying the
    // assertion so the failure mode is the same in both cases.
    if (record.accountId !== accountId || record.sessionToken !== sessionToken) {
      return json({ error: "challenge binding mismatch" }, 400);
    }
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
    // 32 bytes of randomness: long enough that guessing is not a threat
    // model, short enough to fit anywhere. The shape mirrors the session
    // token so the same string-handling code (storage, regex, length) works.
    const stepUpBytes = new Uint8Array(32);
    crypto.getRandomValues(stepUpBytes);
    const stepUpToken = [...stepUpBytes]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await mintStepUp(env.OAUTH_TOKENS, stepUpToken, {
      accountId,
      sessionToken,
    });
    return json({ stepUpToken });
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
