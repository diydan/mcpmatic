/**
 * @vitest-environment node
 *
 * End-to-end OAuth flow integration test (Phase 1.5).
 *
 * Walks the full sequence a real MCP client would walk:
 *
 *   1. POST /sessions                        → sessionToken (64 hex)
 *   2. POST /oauth/register                  → clientId + clientSecret
 *   3. POST /oauth/authorize (consent=approve) → 302 with ?code=...&state=...
 *   4. POST /oauth/token (grant=authz_code)   → access_token + refresh_token
 *   5. POST /mcp (Bearer access_token)        → 200 (bridge resolves)
 *
 * Each handler is invoked directly (the brief's option (a)) via the same
 * `Request` shape that would arrive on the wire — only the env shim is
 * stubbed. The route wiring in `worker/index.ts` is exercised by the
 * sibling `worker-routes.test.ts`.
 *
 * The env shim stubs:
 *   - SESSION.getByName(token) → stub with initSession / /check / listTools
 *   - OAUTH_CLIENT.getByName(id) → stub with /register / /get
 *   - OAUTH_CODE.getByName(code) → stub with /issue / /consume
 *   - OAUTH_TOKENS → Map-backed put/get/delete
 *
 * Because the SSRF guard calls `isPrivateUrl` which would DoH-resolve every
 * registered redirect_uri, we mock it to short-circuit to "public". The
 * behavior of `isPrivateUrl` itself is covered by `tests/ssrf.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../worker/is-private-url", () => ({
  isPrivateUrl: vi.fn(),
}));
vi.mock("../worker/doh-resolve4", () => ({
  makeResolve4: () => async () => [] as string[],
}));

import { isPrivateUrl } from "../worker/is-private-url";
import { handleRegister } from "../worker/oauth/register";
import { handleAuthorize } from "../worker/oauth/authorize";
import { handleToken } from "../worker/oauth/token";
import { handleMcp } from "../worker/mcp/server";
import type { OAuthClient, AuthCode, AccessToken } from "../worker/oauth/types";

// RFC 7636 §4.6 KAT — verifier + its S256 challenge. Used here so the real
// `verifyPkce` (not a mock) accepts the verifier.
const PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const REDIRECT_URI = "https://example.com/callback";
const STATE = "xyz";
const CLIENT_NAME = "e2e-test-client";

// ---- env shim ---------------------------------------------------------

interface FetchMock {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface EnvShim {
  env: Env;
  /** Token → whether initSession was called for it. */
  sessions: Map<string, true>;
  /** clientId → OAuthClient. */
  clients: Map<string, OAuthClient>;
  /** code → AuthCode (single-use). */
  codes: Map<string, AuthCode>;
  /** KV backing store. */
  kvStore: Map<string, string>;
}

function makeEnv(): EnvShim {
  const sessions = new Map<string, true>();
  const clients = new Map<string, OAuthClient>();
  const codes = new Map<string, AuthCode>();
  const kvStore = new Map<string, string>();

  let lastClientId: string | undefined;
  let lastCodeId: string | undefined;
  let lastSessionId: string | undefined;

  const clientFetch: FetchMock = vi.fn(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.pathname === "/register") {
      const body = JSON.parse(init!.body as string) as OAuthClient;
      clients.set(lastClientId!, body);
      return Response.json(body);
    }
    if (url.pathname === "/get") {
      const c = clients.get(lastClientId!);
      return c ? Response.json(c) : new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  });
  const clientGetByName = vi.fn((name: string) => {
    lastClientId = name;
    return { fetch: clientFetch };
  });

  const codeFetch: FetchMock = vi.fn(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.pathname === "/issue") {
      const body = JSON.parse(init!.body as string) as AuthCode;
      codes.set(lastCodeId!, body);
      return Response.json({ code: body.code });
    }
    if (method === "POST" && url.pathname === "/consume") {
      const code = codes.get(lastCodeId!);
      if (!code) return new Response("invalid_grant", { status: 400 });
      if (code.used) return new Response("invalid_grant", { status: 400 });
      if (Date.now() > code.expiresAt) return new Response("invalid_grant", { status: 400 });
      const consumed: AuthCode = { ...code, used: true };
      codes.set(lastCodeId!, consumed);
      return Response.json(consumed);
    }
    return new Response("not found", { status: 404 });
  });
  const codeGetByName = vi.fn((name: string) => {
    lastCodeId = name;
    return { fetch: codeFetch };
  });

  const sessionFetch: FetchMock = vi.fn(async (input) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    if (url.pathname === "/check") {
      const id = lastSessionId ?? "";
      return sessions.has(id)
        ? Response.json({ ok: true })
        : new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  });
  // `initSession` is called via the durable object stub's RPC, not via
  // fetch — the handler calls `stub.initSession(token)` directly. So we
  // expose the function on the stub. `getByName` returns a callable stub.
  const sessionGetByName = vi.fn((name: string) => {
    lastSessionId = name;
    return {
      fetch: sessionFetch,
      initSession: async (token: string) => {
        sessions.set(token, true);
      },
      // The MCP handler calls listTools() / callTool() when a tool method
      // is requested. We never trigger that path in this test (we hit
      // `initialize` instead, which doesn't touch the session), but expose
      // the methods so the stub shape matches the real one.
      listTools: async () => [],
      callTool: async (_name: string, _args: Record<string, unknown>) => ({
        ok: true as const,
        text: "ok",
      }),
    };
  });

  const env = {
    SESSION: { getByName: sessionGetByName },
    OAUTH_CLIENT: { getByName: clientGetByName },
    OAUTH_CODE: { getByName: codeGetByName },
    OAUTH_TOKENS: {
      get: vi.fn(async (key: string) =>
        kvStore.has(key) ? kvStore.get(key)! : null,
      ),
      put: vi.fn(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        kvStore.delete(key);
      }),
    },
  } as unknown as Env;

  return { env, sessions, clients, codes, kvStore };
}

// ---- helpers ----------------------------------------------------------

function jsonReq(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function formReq(url: string, fields: Record<string, string>, method = "POST"): Request {
  const body = new URLSearchParams(fields).toString();
  return new Request(url, {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

/**
 * Mint a session token the same way `worker/index.ts::createSession` does —
 * 32 random bytes hex-encoded. Then plant the sentinel row on the SessionDO
 * via `initSession` so /oauth/authorize's /check succeeds for this token.
 */
async function mintSession(shim: EnvShim): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const stub = (shim.env.SESSION as unknown as {
    getByName: (n: string) => { initSession: (t: string) => Promise<void> };
  }).getByName(token);
  await stub.initSession(token);
  shim.sessions.set(token, true);
  return token;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_RE = /^[A-Za-z0-9_\-]{43}$/;

// ---- tests ------------------------------------------------------------

describe("OAuth end-to-end flow (in-process integration)", () => {
  let shim: EnvShim;

  beforeEach(() => {
    shim = makeEnv();
    vi.mocked(isPrivateUrl).mockReset();
    vi.mocked(isPrivateUrl).mockResolvedValue(false);
  });

  it("walks register → authorize → token → mcp and proves the bridge resolves the OAuth access token to the underlying session token", async () => {
    // ---- 0. Create a session (the /sessions endpoint's job) ----------
    // worker/index.ts::createSession mints a 64-hex token and calls
    // stub.initSession(token) so the OAuth authorize handler's /check
    // succeeds for it. We replicate that here.
    const sessionToken = await mintSession(shim);
    expect(sessionToken).toMatch(/^[a-f0-9]{64}$/);

    // ---- 1. Register the OAuth client --------------------------------
    const registerRes = await handleRegister(
      jsonReq("https://worker.local/oauth/register", {
        redirect_uris: [REDIRECT_URI],
        client_name: CLIENT_NAME,
      }),
      shim.env,
    );
    expect(registerRes.status).toBe(201);
    const registered = (await registerRes.json()) as OAuthClient;
    expect(registered.clientId).toMatch(UUID_RE);
    expect(registered.clientSecret).toMatch(BASE64URL_RE);
    expect(registered.redirectUris).toEqual([REDIRECT_URI]);
    expect(registered.clientName).toBe(CLIENT_NAME);

    // Sanity: the client landed in our shim's OAUTH_CLIENT map, keyed by
    // the same clientId. This is what OAuthClientDO does in production.
    expect(shim.clients.get(registered.clientId)).toEqual(registered);

    // ---- 2. Authorize: GET returns HTML, POST consent=approve returns 302
    // First the consent GET — this is what a browser would render. It
    // does NOT consult /sessions because no session_token has been
    // pasted yet.
    const consentGet = await handleAuthorize(
      new Request(
        `https://worker.local/oauth/authorize?response_type=code&client_id=${registered.clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${STATE}&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256`,
        { method: "GET" },
      ),
      shim.env,
    );
    expect(consentGet.status).toBe(200);
    expect(consentGet.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await consentGet.text();
    expect(html).toContain(`value="${registered.clientId}"`);
    expect(html).toContain(`value="${PKCE_CHALLENGE}"`);
    expect(html).toMatch(/name="session_token"/);

    // Now the POST decision. The handler verifies the session_token
    // against SessionDO (/check) and, on approve, issues an auth code via
    // OAuthCodeDO and redirects to the registered redirect_uri with
    // ?code=...&state=...
    const authorizeRes = await handleAuthorize(
      formReq("https://worker.local/oauth/authorize", {
        response_type: "code",
        client_id: registered.clientId,
        redirect_uri: REDIRECT_URI,
        state: STATE,
        code_challenge: PKCE_CHALLENGE,
        code_challenge_method: "S256",
        session_token: sessionToken,
        consent: "approve",
      }),
      shim.env,
    );
    expect(authorizeRes.status).toBe(302);
    const location = authorizeRes.headers.get("location");
    expect(location).not.toBeNull();
    const target = new URL(location!);
    expect(target.origin + target.pathname).toBe(REDIRECT_URI);
    expect(target.searchParams.get("state")).toBe(STATE);

    const code = target.searchParams.get("code");
    expect(code).not.toBeNull();
    expect(code!).toMatch(BASE64URL_RE);
    // session_token MUST NOT leak into the redirect URL — regression.
    expect(target.searchParams.get("session_token")).toBeNull();

    // Sanity: the code landed in our shim's OAUTH_CODE map with the
    // correct bindings (right clientId, right session token, not yet used).
    const storedCode = shim.codes.get(code!);
    expect(storedCode).toBeDefined();
    expect(storedCode!.clientId).toBe(registered.clientId);
    expect(storedCode!.userSessionToken).toBe(sessionToken);
    expect(storedCode!.redirectUri).toBe(REDIRECT_URI);
    expect(storedCode!.codeChallenge).toBe(PKCE_CHALLENGE);
    expect(storedCode!.used).toBe(false);

    // ---- 3. Token exchange --------------------------------------------
    // The PKCE verifier here is the RFC 7636 §4.6 KAT — it matches the
    // challenge we sent at authorize time, so the real verifyPkce
    // (NOT a mock) will accept it.
    const tokenRes = await handleToken(
      formReq("https://worker.local/oauth/token", {
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
        client_id: registered.clientId,
        client_secret: registered.clientSecret,
      }),
      shim.env,
    );
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    expect(tokenRes.headers.get("referrer-policy")).toBe("no-referrer");

    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(tokenBody.access_token).toMatch(BASE64URL_RE);
    expect(tokenBody.refresh_token).toMatch(BASE64URL_RE);
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);
    expect(tokenBody.scope).toBe("mcp:tools");

    // KV got two puts (access + refresh) and NO deletes.
    const tokenKey = `token:${tokenBody.access_token}`;
    const refreshKey = `refresh:${tokenBody.refresh_token}`;
    expect(shim.kvStore.has(tokenKey)).toBe(true);
    expect(shim.kvStore.has(refreshKey)).toBe(true);
    const storedAccess = JSON.parse(shim.kvStore.get(tokenKey)!) as AccessToken;
    expect(storedAccess.userSessionToken).toBe(sessionToken);
    expect(storedAccess.clientId).toBe(registered.clientId);

    // Critical: the code was single-used. The DO consume flipped used=true.
    expect(shim.codes.get(code!)!.used).toBe(true);

    // ---- 4. /mcp with Bearer <access_token> --------------------------
    // This is the load-bearing step: `authenticate` calls `resolveMcpToken`,
    // which recognizes the 43-char base64url shape, looks up
    // `token:<bearer>` in KV, and returns the underlying session token.
    // The /mcp handler then accepts the request — proving the bridge.
    //
    // We use the `initialize` JSON-RPC method because it doesn't touch the
    // SessionDO (only `tools/list` and `tools/call` do); what matters here
    // is that the bearer passed auth, which is the bridge contract.
    const mcpRes = await handleMcp(
      new Request("https://worker.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${tokenBody.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "e2e-test", version: "0.0.0" },
          },
        }),
      }),
      shim.env,
    );
    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(mcpBody.result.serverInfo.name).toBe("browsermatic");

    // And: the same access token can NOT be reused for /mcp without first
    // going through the auth code flow — it carries the userSessionToken,
    // but the userSessionToken is exactly the one we created in step 0, so
    // this isn't a real negative test. Use it to confirm that an UNKNOWN
    // bearer produces a 401 (the bridge returns null → handleMcp 401s).
    const badRes = await handleMcp(
      new Request("https://worker.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer not-a-real-token-at-all",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {},
        }),
      }),
      shim.env,
    );
    expect(badRes.status).toBe(401);
    expect(badRes.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("rejects a forged session_token at /oauth/authorize (no SessionDO sentinel row → no code issued)", async () => {
    // The whole point of planting a sentinel row at /sessions time is to
    // stop a pasted random 64-hex string from minting an OAuth code bound
    // to a token the caller chose. Walk the same flow with a token that
    // was NEVER initialized and confirm the authorize handler refuses.

    const registerRes = await handleRegister(
      jsonReq("https://worker.local/oauth/register", {
        redirect_uris: [REDIRECT_URI],
      }),
      shim.env,
    );
    const registered = (await registerRes.json()) as OAuthClient;

    const forgedToken = "f".repeat(64);
    expect(shim.sessions.has(forgedToken)).toBe(false);

    const authorizeRes = await handleAuthorize(
      formReq("https://worker.local/oauth/authorize", {
        response_type: "code",
        client_id: registered.clientId,
        redirect_uri: REDIRECT_URI,
        state: STATE,
        code_challenge: PKCE_CHALLENGE,
        code_challenge_method: "S256",
        session_token: forgedToken,
        consent: "approve",
      }),
      shim.env,
    );
    expect(authorizeRes.status).toBe(400);
    const body = (await authorizeRes.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/not found/);

    // No codes were minted.
    expect(shim.codes.size).toBe(0);
  });

  it("the issued code is single-use: replay at /oauth/token returns invalid_grant", async () => {
    const sessionToken = await mintSession(shim);
    const registerRes = await handleRegister(
      jsonReq("https://worker.local/oauth/register", {
        redirect_uris: [REDIRECT_URI],
      }),
      shim.env,
    );
    const registered = (await registerRes.json()) as OAuthClient;

    const authorizeRes = await handleAuthorize(
      formReq("https://worker.local/oauth/authorize", {
        response_type: "code",
        client_id: registered.clientId,
        redirect_uri: REDIRECT_URI,
        state: STATE,
        code_challenge: PKCE_CHALLENGE,
        code_challenge_method: "S256",
        session_token: sessionToken,
        consent: "approve",
      }),
      shim.env,
    );
    const code = new URL(authorizeRes.headers.get("location")!).searchParams.get("code")!;

    const firstExchange = await handleToken(
      formReq("https://worker.local/oauth/token", {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
        client_id: registered.clientId,
        client_secret: registered.clientSecret,
      }),
      shim.env,
    );
    expect(firstExchange.status).toBe(200);

    const replay = await handleToken(
      formReq("https://worker.local/oauth/token", {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
        client_id: registered.clientId,
        client_secret: registered.clientSecret,
      }),
      shim.env,
    );
    expect(replay.status).toBe(400);
    const replayBody = (await replay.json()) as { error: string };
    expect(replayBody.error).toBe("invalid_grant");
  });

  it("uses the refresh_token to mint a new access token; old refresh key is rotated out", async () => {
    // Walks steps 1-3 then exercises the refresh grant.
    const sessionToken = await mintSession(shim);
    const registered = (await (await handleRegister(
      jsonReq("https://worker.local/oauth/register", { redirect_uris: [REDIRECT_URI] }),
      shim.env,
    )).json()) as OAuthClient;

    const authorizeRes = await handleAuthorize(
      formReq("https://worker.local/oauth/authorize", {
        response_type: "code",
        client_id: registered.clientId,
        redirect_uri: REDIRECT_URI,
        state: STATE,
        code_challenge: PKCE_CHALLENGE,
        code_challenge_method: "S256",
        session_token: sessionToken,
        consent: "approve",
      }),
      shim.env,
    );
    const code = new URL(authorizeRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      formReq("https://worker.local/oauth/token", {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
        client_id: registered.clientId,
        client_secret: registered.clientSecret,
      }),
      shim.env,
    );
    const firstPair = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
    };

    const refreshRes = await handleToken(
      formReq("https://worker.local/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: firstPair.refresh_token,
        client_id: registered.clientId,
        client_secret: registered.clientSecret,
      }),
      shim.env,
    );
    expect(refreshRes.status).toBe(200);
    const secondPair = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(secondPair.access_token).not.toBe(firstPair.access_token);
    expect(secondPair.refresh_token).not.toBe(firstPair.refresh_token);

    // Old refresh key was rotated out.
    expect(shim.kvStore.has(`refresh:${firstPair.refresh_token}`)).toBe(false);
    // New keys exist.
    expect(shim.kvStore.has(`token:${secondPair.access_token}`)).toBe(true);
    expect(shim.kvStore.has(`refresh:${secondPair.refresh_token}`)).toBe(true);

    // And the new access token resolves at /mcp — same userSessionToken.
    const mcpRes = await handleMcp(
      new Request("https://worker.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${secondPair.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      }),
      shim.env,
    );
    expect(mcpRes.status).toBe(200);
  });
});