/**
 * Token endpoint per RFC 6749 §3.2, §4.1.3 (authorization_code grant) and
 * §6 (refresh_token grant).
 *
 * Two grant types are supported:
 *
 * 1. `authorization_code` — POST `code`, `redirect_uri`, `code_verifier`.
 *    The stored AuthCode is atomically consumed from `OAuthCodeDO`; client +
 *    redirect_uri must match; PKCE verifier must hash to the stored challenge
 *    (RFC 7636); on success, a fresh access + refresh token pair is written
 *    to `OAUTH_TOKENS` KV.
 *
 * 2. `refresh_token` — POST `refresh_token`. The stored `AccessToken` is
 *    looked up under `refresh:<rt>`; clientId must match; on success, the
 *    *old* refresh key is deleted FIRST (linearization point — H3-agent,
 *    2026-09-04 review), then a new access + refresh pair is written in
 *    parallel. Deleting first means a worker crash between the writes
 *    cannot leave two valid refresh tokens indefinitely.
 *
 * Client authentication in this handler is via form params
 * (`client_id` + `client_secret`). Confidential clients per RFC 6749 §2.3.1.
 *
 * Security headers — `FACADE_HEADERS` + `Cache-Control: no-store` — are
 * spread onto EVERY response from this handler (200 OK, 400 JSON, 401 JSON)
 * via `jsonError()`. RFC 6749 §5.1 mandates `no-store` on the success
 * response so the token is not cached by any intermediary; we extend that to
 * the error responses too because the only thing this endpoint returns is
 * either a bearer token or an `error=...` field that callers should not
 * cache or be tricked into replaying.
 *
 * NOTE: We do NOT re-verify the user `session_token` here. The AuthCode has a
 * 10-minute TTL (Task 6) and a single-use consume (Task 6); the window for an
 * attacker who steals a code before the legitimate client exchanges it is
 * bounded by that TTL. The access token we mint carries the session_token,
 * and the downstream `/mcp` handler (Task 8) re-verifies it against the
 * SessionDO on every authenticated request, so a forged session_token is
 * rejected with 401 at /mcp, not here.
 */
import { FACADE_HEADERS } from "../facade-headers";
import { base64urlNoPad } from "./encoding";
import { verifyPkce } from "./pkce";
import { verifySecret } from "./secret";
import type { AccessToken, AuthCode, OAuthClient } from "./types";

/** Stub origin for the OAuth DO fetch — the DOs ignore the URL. */
const DO_STUB_ORIGIN = "https://stub";

const NO_STORE = { "Cache-Control": "no-store" };

/** RFC 6749 §4.2.2: 1 hour in seconds. */
const ACCESS_TOKEN_TTL_SECONDS = 3600;
/** RFC 6749 §4.2.2: 30 days in seconds. */
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
/** Hard-coded scope for MCP tools. */
const SCOPE = "mcp:tools";

export async function handleToken(request: Request, env: Env): Promise<Response> {
  // Token endpoint accepts POST only per RFC 6749 §3.2 — the request is a
  // form-urlencoded body.
  if (request.method !== "POST") {
    return jsonError("invalid_request", 400);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("invalid_request", 400);
  }

  const grantType = stringField(form, "grant_type");
  const clientId = stringField(form, "client_id");
  const clientSecret = stringField(form, "client_secret");

  // Authenticate the client BEFORE any other work — a bogus client_id must
  // never reach the code-consume path. We swallow the difference between
  // "unknown client" and "wrong secret" into a single `invalid_client` so we
  // do not leak which client_ids are registered.
  const client = await authenticateClient(clientId, clientSecret, env);
  if (!client) return jsonError("invalid_client", 401);

  if (grantType === "authorization_code") {
    return exchangeCode(form, env, client);
  }
  if (grantType === "refresh_token") {
    return refreshAccessToken(form, env, client);
  }
  return jsonError("unsupported_grant_type", 400);
}

/**
 * Look up the client by id and verify the secret. Returns the client JSON on
 * success, null on any failure (unknown id, wrong secret, or missing hash
 * fields on the stored record).
 *
 * The persisted `OAuthClient` carries the secret as a salted SHA-256 hash
 * (`sha256:<hex>`, salt = the clientId). We re-derive the hash with the
 * same salt and constant-time compare against the stored value — a network
 * attacker who can repeatedly POST to /oauth/token cannot observe a
 * per-byte timing leak. DSRV-L1 (no plaintext at rest) and DSRV-L2
 * (constant-time compare on the hash) both land here.
 */
async function authenticateClient(
  clientId: string,
  clientSecret: string,
  env: Env,
): Promise<OAuthClient | null> {
  if (!clientId || !clientSecret) return null;
  const clientStub = env.OAUTH_CLIENT.getByName(clientId);
  const clientRes = await clientStub.fetch(`${DO_STUB_ORIGIN}/get`);
  if (clientRes.status !== 200) return null;
  const client = (await clientRes.json()) as OAuthClient;
  // Salt is the clientId — same value as at registration time. The constant-
  // time compare is inside `verifySecret`.
  const ok = await verifySecret(clientSecret, client.clientSecretHash, clientId);
  return ok ? client : null;
}

async function exchangeCode(
  form: FormData,
  env: Env,
  client: OAuthClient,
): Promise<Response> {
  const code = stringField(form, "code");
  const redirectUri = stringField(form, "redirect_uri");
  const codeVerifier = stringField(form, "code_verifier");
  if (!code || !redirectUri || !codeVerifier) {
    return jsonError("invalid_request", 400);
  }

  // Atomic single-use consume. A non-200 here means either:
  //   - no code has been issued under this id (404 from the DO)
  //   - the code has already been used (400 invalid_grant)
  //   - the code has expired (400 invalid_grant)
  //   - the DO itself errored (500)
  // All four collapse to RFC 6749 §5.2 `invalid_grant`. We do NOT re-verify
  // `userSessionToken` here — see the file-level comment for why.
  const codeStub = env.OAUTH_CODE.getByName(code);
  const consumeRes = await codeStub.fetch(`${DO_STUB_ORIGIN}/consume`, {
    method: "POST",
  });
  if (consumeRes.status !== 200) return jsonError("invalid_grant", 400);

  const authCode = (await consumeRes.json()) as AuthCode;
  if (authCode.clientId !== client.clientId) return jsonError("invalid_grant", 400);
  if (authCode.redirectUri !== redirectUri) return jsonError("invalid_grant", 400);

  // PKCE is mandatory (constraint #9). `verifyPkce` enforces the RFC 7636
  // verifier length/charset rules before hashing, and uses a constant-time
  // compare on the digest. A false return here is the catch-all for
  // "code_verifier was wrong".
  const ok = await verifyPkce(codeVerifier, authCode.codeChallenge);
  if (!ok) return jsonError("invalid_grant", 400);

  const accessToken = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const refreshToken = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const tok: AccessToken = {
    token: accessToken,
    clientId: client.clientId,
    userSessionToken: authCode.userSessionToken,
    scope: SCOPE,
    expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
    refreshToken,
  };

  await env.OAUTH_TOKENS.put(`token:${accessToken}`, JSON.stringify(tok), {
    expirationTtl: ACCESS_TOKEN_TTL_SECONDS,
  });
  await env.OAUTH_TOKENS.put(`refresh:${refreshToken}`, JSON.stringify(tok), {
    expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
  });

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: SCOPE,
    }),
    {
      status: 200,
      headers: {
        ...FACADE_HEADERS,
        ...NO_STORE,
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

async function refreshAccessToken(
  form: FormData,
  env: Env,
  client: OAuthClient,
): Promise<Response> {
  const rt = stringField(form, "refresh_token");
  if (!rt) return jsonError("invalid_request", 400);

  // KV.get returns null when the key is missing OR has been deleted (the
  // previous refresh rotation deletes the old refresh key). Either way the
  // refresh token is no longer valid.
  const tokJson = await env.OAUTH_TOKENS.get(`refresh:${rt}`);
  if (!tokJson) return jsonError("invalid_grant", 400);

  const tok = JSON.parse(tokJson) as AccessToken;
  // Client mismatch — the refresh token was minted for a DIFFERENT client
  // than the one presenting it. Treat as invalid_grant; we do NOT touch KV.
  if (tok.clientId !== client.clientId) return jsonError("invalid_grant", 400);

  // Rotate: delete the old refresh key FIRST, then issue the fresh pair.
  // Per 2026-09-04 review (H3-agent): the previous order wrote the new
  // pair before deleting the old key. A worker crash between those two
  // writes left two valid refresh tokens indefinitely (the "double
  // rotation" vulnerability). Deleting first means a crash during the
  // new writes only forces the user to re-authenticate.
  try {
    await env.OAUTH_TOKENS.delete(`refresh:${rt}`);
  } catch {
    // Delete is the linearization point — if it fails, no writes have
    // been attempted yet, so there are no orphans to clean up. Fail
    // gracefully with a 500; the user retries.
    return jsonError("server_error", 500);
  }

  const accessToken = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const newRefresh = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const newTok: AccessToken = {
    ...tok,
    token: accessToken,
    refreshToken: newRefresh,
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
  };

  // Both writes depend only on the delete having succeeded — run them in
  // parallel. If a put fails, the old refresh key is already gone and
  // the user has to re-authenticate; that is acceptable per the
  // 2026-09-04 review (better than orphaning two valid refresh tokens).
  await Promise.all([
    env.OAUTH_TOKENS.put(`token:${accessToken}`, JSON.stringify(newTok), {
      expirationTtl: ACCESS_TOKEN_TTL_SECONDS,
    }),
    env.OAUTH_TOKENS.put(`refresh:${newRefresh}`, JSON.stringify(newTok), {
      expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
    }),
  ]);

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: newRefresh,
      scope: tok.scope,
    }),
    {
      status: 200,
      headers: {
        ...FACADE_HEADERS,
        ...NO_STORE,
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

/**
 * Build a JSON error response. Spreads `FACADE_HEADERS` + `Cache-Control:
 * no-store` so every response from this handler carries the same security
 * posture regardless of status. The body is `{ error: <code> }` per RFC
 * 6749 §5.2.
 */
function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      ...FACADE_HEADERS,
      ...NO_STORE,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function stringField(form: FormData, key: string): string {
  const v = form.get(key);
  // Empty form fields come back as "" — treat as missing so the request
  // is rejected with invalid_request rather than silently accepted.
  return typeof v === "string" ? v : "";
}
