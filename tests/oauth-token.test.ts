/**
 * @vitest-environment node
 *
 * Tests for `handleToken` (POST /oauth/token) — RFC 6749 §4.1.3 + §6.
 *
 * `handleToken` reaches into four surfaces:
 *   - OAUTH_CLIENT.getByName(clientId).fetch("/get") for client auth.
 *   - OAUTH_CODE.getByName(code).fetch("/consume", POST) for the single-use
 *     auth code consume.
 *   - OAUTH_TOKENS.put / get / delete for minted tokens.
 *   - `verifyPkce` is mocked at the module boundary so we can flip between
 *     pass/fail without depending on the PKCE digest.
 *
 * Tests build an env shim with a `Map`-backed KV, vitest mocks for the DO
 * fetches, and `vi.spyOn(..., "verifyPkce")` for the verifier.
 *
 * DSRV-L1: client_secret is NEVER persisted on `OAuthClient`. The shim's
 * `clients` map carries `clientSecretHash` (a real salted SHA-256 of the
 * plaintext + the clientId), matching `register.ts`. Tests POST the
 * plaintext to `/oauth/token` per RFC 6749 §2.3.1.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { handleToken } from "../worker/oauth/token";
import { hashSecret } from "../worker/oauth/secret";
import type { AccessToken, AuthCode, OAuthClient } from "../worker/oauth/types";

type FetchMock = ReturnType<typeof vi.fn>;

interface EnvShim {
  env: Env;
  clientGetByName: FetchMock;
  clientFetch: FetchMock;
  codeGetByName: FetchMock;
  codeFetch: FetchMock;
  kv: {
    store: Map<string, string>;
    get: FetchMock;
    put: FetchMock;
    delete: FetchMock;
  };
}

// Plaintext + ids for the two canonical test clients. The shim's persisted
// `OAuthClient` is built fresh per test in `beforeEach` so its hash matches
// the real production code path.
const CLIENT_ID = "client-abc";
const CLIENT_SECRET = "secret-xyz";
const OTHER_CLIENT_ID = "other-client";
const OTHER_CLIENT_SECRET = "other-secret";

const REDIRECT_URI = "https://example.com/cb";
// RFC 7636 §4.6 KAT — matches the verifier used for tests.
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const SESSION_TOKEN = "a".repeat(64);
const AUTH_CODE_STRING = "auth-code-xyz";

const BASE64URL_RE = /^[A-Za-z0-9_\-]{43}$/;

/**
 * Build a fully-formed `OAuthClient` whose `clientSecretHash` is a real
 * salted SHA-256 of the plaintext under `salt = clientId` — the same
 * scheme `register.ts` uses. `salt = clientId` lets us re-derive the
 * exact same digest at verify time without storing the salt separately.
 */
async function buildClient(
  clientId: string,
  secret: string,
  overrides: Partial<OAuthClient> = {},
): Promise<OAuthClient> {
  return {
    clientId,
    clientSecretHash: await hashSecret(secret, clientId),
    redirectUris: ["https://example.com/cb"],
    clientName: "test client",
    createdAt: 1700000000000,
    ...overrides,
  };
}

function authCodeFixture(
  clientId: string = CLIENT_ID,
  overrides: Partial<AuthCode> = {},
): AuthCode {
  return {
    code: AUTH_CODE_STRING,
    clientId,
    userSessionToken: SESSION_TOKEN,
    redirectUri: REDIRECT_URI,
    codeChallenge: CODE_CHALLENGE,
    codeChallengeMethod: "S256",
    // 10 minutes from now — well within the brief's lifetime.
    expiresAt: Date.now() + 10 * 60 * 1000,
    used: false,
    ...overrides,
  };
}

function makeEnv(initialClients: Record<string, OAuthClient> = {}): EnvShim {
  // Track the most-recently-requested id from each DO so the fetch mock
  // can resolve the right client/code without us threading `name` into the
  // fetch shape (which is a Request and discards the `name` argument).
  let lastClientId: string | undefined = undefined;
  let lastCodeId: string | undefined = undefined;

  const clients = new Map<string, OAuthClient>(Object.entries(initialClients));

  const clientFetch = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.pathname === "/get") {
        const id = lastClientId ?? "";
        const client = clients.get(id);
        return client
          ? Response.json(client)
          : new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });
  const clientGetByName = vi
    .fn<(name: string) => { fetch: FetchMock }>()
    .mockImplementation((name: string) => {
      lastClientId = name;
      return { fetch: clientFetch };
    });

  const codeFetch = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async (_input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        const url = new URL(typeof _input === "string" ? _input : (_input as Request).url);
        if (url.pathname === "/consume") {
          // Default behavior is "no code issued" — tests seed the store
          // by setting `codeFetch.mockResolvedValueOnce(...)` per case.
          return new Response("invalid_grant", { status: 400 });
        }
      }
      return new Response("not found", { status: 404 });
    });
  const codeGetByName = vi
    .fn<(name: string) => { fetch: FetchMock }>()
    .mockImplementation((name: string) => {
      lastCodeId = name;
      return { fetch: codeFetch };
    });

  const store = new Map<string, string>();
  const kv = {
    store,
    get: vi.fn<(key: string) => Promise<string | null>>().mockImplementation(async (key: string) => {
      return store.has(key) ? store.get(key)! : null;
    }),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      store.delete(key);
    }),
  };

  const env = {
    OAUTH_CLIENT: { getByName: clientGetByName },
    OAUTH_CODE: { getByName: codeGetByName },
    OAUTH_TOKENS: kv,
  } as unknown as Env;

  return {
    env,
    clientGetByName,
    clientFetch,
    codeGetByName,
    codeFetch,
    kv,
  };
}

function tokenReq(params: Record<string, string>): Request {
  const body = new URLSearchParams(params).toString();
  return new Request("https://worker.local/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("handleToken (POST /oauth/token) — RFC 6749 §4.1.3 + §6", () => {
  let shim: EnvShim;
  let pkceMock: ReturnType<typeof vi.spyOn>;
  let clientFixture: OAuthClient;
  let otherClientFixture: OAuthClient;

  beforeEach(async () => {
    // Build the fixtures with REAL salted SHA-256 hashes so the verify
    // path in `handleToken` runs through `verifySecret` against a hash
    // a real `register.ts` call would have produced.
    clientFixture = await buildClient(CLIENT_ID, CLIENT_SECRET);
    otherClientFixture = await buildClient(
      OTHER_CLIENT_ID,
      OTHER_CLIENT_SECRET,
      {
        clientId: OTHER_CLIENT_ID,
        redirectUris: ["https://other.example/cb"],
        clientName: "other client",
      },
    );

    shim = makeEnv({
      [clientFixture.clientId]: clientFixture,
    });

    // Default: PKCE verifier matches the challenge. The PKCE module is the
    // real implementation; individual tests can override per-case.
    const pkce = await import("../worker/oauth/pkce");
    pkceMock = vi.spyOn(pkce, "verifyPkce").mockImplementation(
      async (verifier: string, challenge: string) => {
        // Match the RFC 7636 §4.6 KAT only — tests can flip the mock
        // to return false when they want a PKCE failure.
        return (
          verifier === "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" &&
          challenge === "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
      },
    );
  });

  // -------------------------------------------------------------
  // authorization_code grant
  // -------------------------------------------------------------

  it("happy path: 200 with access_token (43 base64url chars), Bearer, expires_in=3600, refresh_token, scope=mcp:tools; tokens written to KV; headers carry no-store + no-referrer", async () => {
    const code = authCodeFixture();
    shim.codeFetch.mockResolvedValueOnce(Response.json(code));

    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: code.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      scope: string;
    };
    expect(body.access_token).toMatch(BASE64URL_RE);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.refresh_token).toMatch(BASE64URL_RE);
    expect(body.scope).toBe("mcp:tools");

    // Two KV writes: token + refresh.
    expect(shim.kv.put).toHaveBeenCalledTimes(2);
    const putKeys = shim.kv.put.mock.calls.map((c) => c[0] as string);
    expect(putKeys).toContain(`token:${body.access_token}`);
    expect(putKeys).toContain(`refresh:${body.refresh_token}`);

    // Token TTL is 1 hour, refresh TTL is 30 days.
    const tokenPut = shim.kv.put.mock.calls.find(
      (c) => (c[0] as string) === `token:${body.access_token}`,
    )!;
    const refreshPut = shim.kv.put.mock.calls.find(
      (c) => (c[0] as string) === `refresh:${body.refresh_token}`,
    )!;
    expect((tokenPut[2] as { expirationTtl: number }).expirationTtl).toBe(3600);
    expect((refreshPut[2] as { expirationTtl: number }).expirationTtl).toBe(60 * 60 * 24 * 30);

    // Stored access token payload is well-formed.
    const storedToken = JSON.parse(tokenPut[1] as string) as AccessToken;
    expect(storedToken.token).toBe(body.access_token);
    expect(storedToken.clientId).toBe(clientFixture.clientId);
    expect(storedToken.userSessionToken).toBe(SESSION_TOKEN);
    expect(storedToken.scope).toBe("mcp:tools");
    expect(storedToken.refreshToken).toBe(body.refresh_token);
    expect(storedToken.expiresAt).toBeGreaterThan(Date.now());
    expect(storedToken.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 50);

    // DSRV-L1: persisted hash equals a real salted SHA-256 of (plaintext,
    // clientId). The shim stored exactly what `register.ts` would store.
    expect(clientFixture.clientSecretHash).toBe(
      await hashSecret(CLIENT_SECRET, clientFixture.clientId),
    );
    expect(clientFixture.clientSecretHash.startsWith("sha256:")).toBe(true);
  });

  it("wrong client_secret → 401 invalid_client; code DO consume NOT called; KV NOT touched", async () => {
    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: AUTH_CODE_STRING,
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        client_id: clientFixture.clientId,
        client_secret: "wrong-secret",
      }),
      shim.env,
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");

    // Critical: no consume, no KV writes.
    expect(shim.codeGetByName).not.toHaveBeenCalled();
    expect(shim.codeFetch).not.toHaveBeenCalled();
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("unknown client_id (DO get returns 404) → 401 invalid_client; code DO NOT called", async () => {
    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: AUTH_CODE_STRING,
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        client_id: "no-such-client",
        client_secret: "anything",
      }),
      shim.env,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
    // We still resolve the client stub — the brief's pattern is "look up,
    // 404 collapses to invalid_client". The CODE DO is the line we draw.
    expect(shim.clientGetByName).toHaveBeenCalledWith("no-such-client");
    expect(shim.codeGetByName).not.toHaveBeenCalled();
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("PKCE verifier mismatch → 400 invalid_grant; KV NOT touched", async () => {
    pkceMock.mockResolvedValueOnce(false);

    const code = authCodeFixture();
    shim.codeFetch.mockResolvedValueOnce(Response.json(code));

    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: code.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: "totally-wrong-verifier-that-is-the-right-shape-aaaaaaaaaa",
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");

    // The code WAS consumed atomically — but no tokens were minted.
    expect(shim.codeFetch).toHaveBeenCalledTimes(1);
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("replay of consumed code (consume returns non-200) → 400 invalid_grant; KV NOT touched", async () => {
    // First consume: succeeds (we don't even need this value — we want to
    // assert that a SUBSEQUENT non-200 from the DO is handled as 400
    // invalid_grant). Set the mock to return a 400 invalid_grant directly.
    shim.codeFetch.mockResolvedValueOnce(new Response("invalid_grant", { status: 400 }));

    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: "already-used-code",
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    expect(shim.codeFetch).toHaveBeenCalledTimes(1);
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("redirect_uri mismatch → 400 invalid_grant; KV NOT touched", async () => {
    const code = authCodeFixture();
    shim.codeFetch.mockResolvedValueOnce(Response.json(code));

    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: code.code,
        redirect_uri: "https://attacker.example/cb",
        code_verifier: CODE_VERIFIER,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("missing code_verifier → 400 invalid_request", async () => {
    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: AUTH_CODE_STRING,
        redirect_uri: REDIRECT_URI,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    // Client auth runs first (it's the gate for everything), so the client
    // DO IS called; the CODE DO is the line we draw — never reach it when
    // a required code-exchange param is missing.
    expect(shim.clientGetByName).toHaveBeenCalled();
    expect(shim.codeGetByName).not.toHaveBeenCalled();
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("missing redirect_uri → 400 invalid_request", async () => {
    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: AUTH_CODE_STRING,
        code_verifier: CODE_VERIFIER,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(shim.codeGetByName).not.toHaveBeenCalled();
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("missing code → 400 invalid_request", async () => {
    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(shim.codeGetByName).not.toHaveBeenCalled();
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("unsupported grant_type (e.g. password) → 400 unsupported_grant_type", async () => {
    const res = await handleToken(
      tokenReq({
        grant_type: "password",
        username: "alice",
        password: "hunter2",
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_grant_type");
    expect(shim.codeGetByName).not.toHaveBeenCalled();
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("non-POST method → 400 invalid_request", async () => {
    const res = await handleToken(
      new Request("https://worker.local/oauth/token", { method: "GET" }),
      shim.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(shim.clientGetByName).not.toHaveBeenCalled();
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("clientId on the code does not match the authenticated client → 400 invalid_grant", async () => {
    // The DO hands us an AuthCode bound to a DIFFERENT client — the
    // authenticated client must not be able to exchange it.
    const code = authCodeFixture("some-other-client");
    shim.codeFetch.mockResolvedValueOnce(Response.json(code));

    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: code.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------
  // refresh_token grant
  // -------------------------------------------------------------

  it("refresh_token happy path: 200 with new access_token + refresh_token; old refresh key deleted; KV gets 2 new puts + 1 delete", async () => {
    const oldRt = "old-refresh-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const oldTok: AccessToken = {
      token: "old-access-token-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
      clientId: clientFixture.clientId,
      userSessionToken: SESSION_TOKEN,
      scope: "mcp:tools",
      expiresAt: Date.now() + 60 * 1000,
      refreshToken: oldRt,
    };
    shim.kv.store.set(`refresh:${oldRt}`, JSON.stringify(oldTok));

    const res = await handleToken(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: oldRt,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      scope: string;
    };
    expect(body.access_token).toMatch(BASE64URL_RE);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.refresh_token).toMatch(BASE64URL_RE);
    expect(body.refresh_token).not.toBe(oldRt);
    expect(body.scope).toBe("mcp:tools");

    // Old refresh key was deleted.
    expect(shim.kv.delete).toHaveBeenCalledTimes(1);
    expect(shim.kv.delete).toHaveBeenCalledWith(`refresh:${oldRt}`);
    expect(shim.kv.store.has(`refresh:${oldRt}`)).toBe(false);

    // Two new keys were written.
    expect(shim.kv.put).toHaveBeenCalledTimes(2);
    const putKeys = shim.kv.put.mock.calls.map((c) => c[0] as string);
    expect(putKeys).toContain(`token:${body.access_token}`);
    expect(putKeys).toContain(`refresh:${body.refresh_token}`);

    // TTLs unchanged across the delete-before-write move: access 1h,
    // refresh 30d. The `Promise.all` rewrite carried these verbatim.
    const tokenPut = shim.kv.put.mock.calls.find(
      (c) => (c[0] as string) === `token:${body.access_token}`,
    )!;
    const refreshPut = shim.kv.put.mock.calls.find(
      (c) => (c[0] as string) === `refresh:${body.refresh_token}`,
    )!;
    expect((tokenPut[2] as { expirationTtl: number }).expirationTtl).toBe(3600);
    expect((refreshPut[2] as { expirationTtl: number }).expirationTtl).toBe(60 * 60 * 24 * 30);

    // The new stored token carries the original userSessionToken + scope
    // — refreshing does not require a fresh consent round-trip.
    const newStored = JSON.parse(
      shim.kv.store.get(`token:${body.access_token}`)!,
    ) as AccessToken;
    expect(newStored.clientId).toBe(clientFixture.clientId);
    expect(newStored.userSessionToken).toBe(SESSION_TOKEN);
    expect(newStored.scope).toBe("mcp:tools");
    expect(newStored.refreshToken).toBe(body.refresh_token);
  });

  it("refresh with unknown refresh_token (KV.get returns null) → 400 invalid_grant", async () => {
    const res = await handleToken(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: "never-issued-token",
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    expect(shim.kv.put).not.toHaveBeenCalled();
    expect(shim.kv.delete).not.toHaveBeenCalled();
  });

  it("refresh with a previously-deleted refresh_token (KV.get returns null) → 400 invalid_grant", async () => {
    const rt = "revoked-refresh-token-aaaaaaaaaaaaaaaaaaaaaaaaaa";
    // Note: we never set it in the store — equivalent to "the previous
    // refresh already deleted it".
    const res = await handleToken(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: rt,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    expect(shim.kv.put).not.toHaveBeenCalled();
    expect(shim.kv.delete).not.toHaveBeenCalled();
  });

  it("refresh with mismatched client_id (token belongs to a different client) → 400 invalid_grant; KV NOT touched", async () => {
    const rt = "rt-issued-to-other-client-aaaaaaaaaaaaaaaaaaaaaaaaa";
    const otherTok: AccessToken = {
      token: "access-issued-to-other-client-bbbbbbbbbbbbbbbbbbbbb",
      clientId: otherClientFixture.clientId,
      userSessionToken: SESSION_TOKEN,
      scope: "mcp:tools",
      expiresAt: Date.now() + 60 * 1000,
      refreshToken: rt,
    };
    shim.kv.store.set(`refresh:${rt}`, JSON.stringify(otherTok));

    const res = await handleToken(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: rt,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    // Critical: we must NOT mint or rotate tokens when the client mismatches.
    expect(shim.kv.put).not.toHaveBeenCalled();
    expect(shim.kv.delete).not.toHaveBeenCalled();
    // The original key is still in the store — we never touched it.
    expect(shim.kv.store.has(`refresh:${rt}`)).toBe(true);
  });

  it("refresh with missing refresh_token param → 400 invalid_request", async () => {
    const res = await handleToken(
      tokenReq({
        grant_type: "refresh_token",
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------
  // refresh_token rotation ordering — H3-agent (2026-09-04 review)
  // -------------------------------------------------------------

  it("refresh rotation: delete is the linearization point — delete-before-write (H3-agent)", async () => {
    // H3-agent: the previous code wrote the new pair FIRST and only THEN
    // deleted the old refresh key. A worker crash between those two writes
    // left two valid refresh tokens indefinitely (the "double-rotation"
    // vulnerability). The fix deletes the old key first; if the new writes
    // crash, the user simply re-authenticates.
    //
    // This test stubs `kv.delete` to throw (simulating a partial-failure
    // crash) and asserts that NO new writes are committed — proving the
    // delete-before-write ordering. If the puts ran first (the bug), the
    // store would still contain orphan new keys.
    const oldRt = "old-refresh-token-partial-failure-xxxxxxxxxxxxxxx";
    const oldTok: AccessToken = {
      token: "old-access-token-partial-failure-yyyyyyyyyyyyyyyyyy",
      clientId: clientFixture.clientId,
      userSessionToken: SESSION_TOKEN,
      scope: "mcp:tools",
      expiresAt: Date.now() + 60 * 1000,
      refreshToken: oldRt,
    };
    shim.kv.store.set(`refresh:${oldRt}`, JSON.stringify(oldTok));

    // Track the order of KV operations to prove the ordering.
    const order: string[] = [];

    shim.kv.delete.mockImplementation(async (key: string) => {
      order.push(`delete:${key}`);
      shim.kv.store.delete(key);
      throw new Error("KV delete failed (simulated partial failure)");
    });
    shim.kv.put.mockImplementation(async (key: string, value: string) => {
      order.push(`put:${key}`);
      shim.kv.store.set(key, value);
    });

    const res = await handleToken(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: oldRt,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    // Critical: no puts should have been committed — delete-before-write
    // means a delete failure short-circuits the rotation, with no orphan
    // new keys left in the store. The old bug would have committed both
    // puts before the delete threw, leaving two orphan valid refresh
    // tokens in the store.
    const putCalls = order.filter((c) => c.startsWith("put:"));
    expect(putCalls).toEqual([]);

    // delete was attempted (it's the linearization point). With the new
    // code it runs BEFORE any put; with the old code it would have run
    // AFTER, which is exactly the bug this test catches.
    const deleteCalls = order.filter((c) => c.startsWith("delete:"));
    expect(deleteCalls).toEqual([`delete:refresh:${oldRt}`]);

    // Graceful failure: the `try/catch` around `kv.delete` must convert
    // the throw into a `jsonError("server_error", 500)`. If the catch is
    // ever removed, the throw escapes and the runtime 500s with no
    // `Cache-Control: no-store` and no RFC-shape body — these three
    // assertions below pin the catch wired up correctly.
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_error" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refresh rotation: delete-then-write — delete is the FIRST KV op on a clean run (H3-agent)", async () => {
    // Sibling assertion to the partial-failure test above: even on a
    // CLEAN refresh (no KV errors), the delete of the old refresh key
    // must happen BEFORE the two puts of the new pair. If delete were
    // last (the old order), a worker crash between the puts and the
    // delete would leave the old refresh key still valid alongside the
    // newly minted one.
    const oldRt = "old-refresh-token-ordering-check-xxxxxxxxxxxxxxxx";
    const oldTok: AccessToken = {
      token: "old-access-token-ordering-check-yyyyyyyyyyyyyyyyyy",
      clientId: clientFixture.clientId,
      userSessionToken: SESSION_TOKEN,
      scope: "mcp:tools",
      expiresAt: Date.now() + 60 * 1000,
      refreshToken: oldRt,
    };
    shim.kv.store.set(`refresh:${oldRt}`, JSON.stringify(oldTok));

    // Track the order of KV operations to prove the ordering.
    const order: string[] = [];
    const originalPut = shim.kv.put.getMockImplementation();
    const originalDelete = shim.kv.delete.getMockImplementation();
    shim.kv.put.mockImplementation(async (key: string, value: string, opts?: unknown) => {
      order.push(`put:${key}`);
      if (originalPut) await originalPut(key, value, opts as { expirationTtl?: number });
    });
    shim.kv.delete.mockImplementation(async (key: string) => {
      order.push(`delete:${key}`);
      if (originalDelete) await originalDelete(key);
    });

    const res = await handleToken(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: oldRt,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(200);

    // Find the indices of the delete and the first put.
    const deleteIdx = order.findIndex((c) => c.startsWith("delete:"));
    const firstPutIdx = order.findIndex((c) => c.startsWith("put:"));

    // delete was called exactly once (the old key) and at least one put
    // happened (the new pair).
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(firstPutIdx).toBeGreaterThanOrEqual(0);

    // delete must precede every put — the bug being fixed was that puts
    // ran before the delete.
    expect(deleteIdx).toBeLessThan(firstPutIdx);

    // The delete targeted the OLD refresh key (specifically `refresh:` prefix).
    expect(order[deleteIdx]).toBe(`delete:refresh:${oldRt}`);
  });

  // -------------------------------------------------------------
  // Security headers (cross-cutting)
  // -------------------------------------------------------------

  it("200 OK response carries Referrer-Policy: no-referrer and Cache-Control: no-store", async () => {
    const code = authCodeFixture();
    shim.codeFetch.mockResolvedValueOnce(Response.json(code));

    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: code.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("400 JSON error response carries Referrer-Policy: no-referrer and Cache-Control: no-store", async () => {
    const res = await handleToken(
      tokenReq({
        grant_type: "password",
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("401 JSON error response carries Referrer-Policy: no-referrer and Cache-Control: no-store", async () => {
    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: AUTH_CODE_STRING,
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        client_id: clientFixture.clientId,
        client_secret: "wrong",
      }),
      shim.env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // -------------------------------------------------------------
  // DO consume status check (regression guard)
  // -------------------------------------------------------------

  it("DO consume returning 500 collapses to 400 invalid_grant (not 500, not 200)", async () => {
    // The brief's ruling: a non-200 consume means invalid_grant, including
    // 5xx from the DO. This used to leak through as a 500; the fix is to
    // treat ANY non-200 from consume as invalid_grant.
    shim.codeFetch.mockResolvedValueOnce(
      new Response("internal error", { status: 500 }),
    );

    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: AUTH_CODE_STRING,
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        client_id: clientFixture.clientId,
        client_secret: CLIENT_SECRET,
      }),
      shim.env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    expect(shim.kv.put).not.toHaveBeenCalled();
  });
});
