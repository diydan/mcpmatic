/**
 * @vitest-environment node
 *
 * End-to-end OAuth flow + real MCP SDK client.
 *
 * The sibling `oauth-e2e.test.ts` walks register → authorize → token → mcp
 * entirely through direct handler calls. This file proves the same surface
 * works against the REAL MCP SDK client — the one that ships in Claude
 * Desktop, ChatGPT, and any custom MCP integration — without modifying
 * either side. That is wire-format compatibility proof, which is the only
 * kind that matters for interop.
 *
 * Approach (option (a) from the brief):
 *   1. Walk the OAuth setup with direct handler calls (same env shim +
 *      PKCE KAT as `oauth-e2e.test.ts`).
 *   2. Build a custom `fetch` shim that takes (url, init), constructs a
 *      `Request`, calls `worker.fetch(request, env)`, and returns the
 *      resulting `Response`. The SDK thinks it is talking to a remote
 *      Worker; the Worker thinks it is serving HTTP.
 *   3. Hand the shim to `StreamableHTTPClientTransport` as its `fetch`.
 *   4. Construct an MCP `Client`, point its transport at the Worker's
 *      `/mcp`, set the Authorization header via `requestInit.headers`,
 *      call `client.connect()`.
 *
 * The SDK's `connect()` is the moment of truth: it sends `initialize`,
 * validates the result against `InitializeResultSchema`, sends the
 * `notifications/initialized` notification, and populates
 * `getServerVersion()`. A successful assertion on
 * `serverInfo.name === "browsermatic"` is wire-format compatibility proof.
 *
 * The SSRF guard (`isPrivateUrl`) is mocked to short-circuit to "public"
 * so the registered redirect_uri does not need a real DNS lookup. The
 * behavior of `isPrivateUrl` itself is covered by `tests/ssrf.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../worker/is-private-url", () => ({
  isPrivateUrl: vi.fn(),
}));
vi.mock("../worker/doh-resolve4", () => ({
  makeResolve4: () => async () => [] as string[],
}));
// `worker/index.ts` re-exports the DO classes for the Cloudflare runtime
// to instantiate. They import `cloudflare:workers`, which the Node test
// environment cannot resolve. Stub them so the default-export import
// chain reaches our handler dispatch without touching real DOs.
vi.mock("../worker/session-do", () => ({ SessionDO: class SessionDO {} }));
vi.mock("../worker/oauth/client-do", () => ({
  OAuthClientDO: class OAuthClientDO {},
}));
vi.mock("../worker/oauth/code-do", () => ({
  OAuthCodeDO: class OAuthCodeDO {},
}));
vi.mock("../worker/account-do", () => ({ AccountDO: class AccountDO {} }));
vi.mock("../worker/site-do", () => ({ SiteDO: class SiteDO {} }));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { isPrivateUrl } from "../worker/is-private-url";
import { handleRegister } from "../worker/oauth/register";
import { handleAuthorize } from "../worker/oauth/authorize";
import { handleToken } from "../worker/oauth/token";
import type { OAuthClient, OAuthClientRegistration, AccessToken } from "../worker/oauth/types";
import worker from "../worker/index";

// RFC 7636 §4.6 KAT — verifier + its S256 challenge. Reused from the
// sibling e2e test so the real `verifyPkce` (not a mock) accepts it.
const PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const WORKER_ORIGIN = "https://worker.local";
const REDIRECT_URI = "https://example.com/callback";
const STATE = "sdk-e2e-state";
const CLIENT_NAME = "sdk-e2e-client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_RE = /^[A-Za-z0-9_\-]{43}$/;

// ---- env shim ----------------------------------------------------------
// Identical in shape to `tests/oauth-e2e.test.ts`. Kept inline here rather
// than shared because the two tests have drifted concerns: the sibling
// focuses on the four OAuth handlers in isolation; this one also needs the
// handler chain to be reachable through a fetch() shim, so any future
// helper refactor must keep both files green simultaneously.

interface EnvShim {
  env: Env;
  sessions: Map<string, true>;
  clients: Map<string, OAuthClient>;
  codes: Map<string, import("../worker/oauth/types").AuthCode>;
  kvStore: Map<string, string>;
}

function makeEnv(): EnvShim {
  const sessions = new Map<string, true>();
  const clients = new Map<string, OAuthClient>();
  const codes = new Map<string, import("../worker/oauth/types").AuthCode>();
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
      const body = JSON.parse(init!.body as string) as import("../worker/oauth/types").AuthCode;
      codes.set(lastCodeId!, body);
      return Response.json({ code: body.code });
    }
    if (method === "POST" && url.pathname === "/consume") {
      const code = codes.get(lastCodeId!);
      if (!code) return new Response("invalid_grant", { status: 400 });
      if (code.used) return new Response("invalid_grant", { status: 400 });
      if (Date.now() > code.expiresAt) return new Response("invalid_grant", { status: 400 });
      const consumed: import("../worker/oauth/types").AuthCode = { ...code, used: true };
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
  const sessionGetByName = vi.fn((name: string) => {
    lastSessionId = name;
    return {
      fetch: sessionFetch,
      initSession: async (token: string) => {
        sessions.set(token, true);
      },
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

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
/** Matches the SDK's `FetchLike` shape (node_modules/@modelcontextprotocol/sdk/dist/esm/shared/transport.d.ts). */
type WorkerFetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

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
 * Mint a session token the same way `worker/index.ts::createSession` does
 * and plant the sentinel row on the SessionDO via `initSession` so the
 * OAuth authorize handler's /check succeeds for it.
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

/**
 * Walk the OAuth setup (register → authorize → token) using direct handler
 * calls — identical to `oauth-e2e.test.ts`. Returns the issued tokens plus
 * the registered client + session, so each test can pick up where the OAuth
 * dance ends.
 */
async function runOAuthSetup(shim: EnvShim): Promise<{
  client: OAuthClientRegistration;
  sessionToken: string;
  accessToken: string;
  refreshToken: string;
}> {
  // Step 0: a real session token. Real clients create this via POST /sessions.
  const sessionToken = await mintSession(shim);

  // Step 1: register the OAuth client.
  const registerRes = await handleRegister(
    jsonReq(`${WORKER_ORIGIN}/oauth/register`, {
      redirect_uris: [REDIRECT_URI],
      client_name: CLIENT_NAME,
    }),
    shim.env,
  );
  if (registerRes.status !== 201) {
    throw new Error(`/oauth/register returned ${registerRes.status}`);
  }
  const client = (await registerRes.json()) as OAuthClientRegistration;

  // Step 2: authorize — POST consent=approve with the session token.
  const authorizeRes = await handleAuthorize(
    formReq(`${WORKER_ORIGIN}/oauth/authorize`, {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      state: STATE,
      code_challenge: PKCE_CHALLENGE,
      code_challenge_method: "S256",
      session_token: sessionToken,
      consent: "approve",
    }),
    shim.env,
  );
  if (authorizeRes.status !== 302) {
    throw new Error(`/oauth/authorize returned ${authorizeRes.status}`);
  }
  const location = authorizeRes.headers.get("location");
  if (!location) throw new Error("/oauth/authorize missing Location header");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("/oauth/authorize Location missing code");

  // Step 3: exchange the code for tokens.
  const tokenRes = await handleToken(
    formReq(`${WORKER_ORIGIN}/oauth/token`, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: PKCE_VERIFIER,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
    shim.env,
  );
  if (tokenRes.status !== 200) {
    throw new Error(`/oauth/token returned ${tokenRes.status}`);
  }
  const tokenBody = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
  };

  return {
    client,
    sessionToken,
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token,
  };
}

/**
 * Build a `FetchLike` that converts the SDK's (url, init) call into a
 * `Request`, dispatches it through the Worker's default fetch handler, and
 * returns the resulting `Response` verbatim. This is the entire wire —
 * nothing else mocks or intercepts the SDK's traffic.
 */
function makeWorkerFetch(shim: EnvShim): WorkerFetchLike {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const request = new Request(urlStr, init);
    return await worker.fetch(request, shim.env);
  };
}

// ---- tests ------------------------------------------------------------

describe("OAuth + real MCP SDK client", () => {
  let shim: EnvShim;

  beforeEach(() => {
    shim = makeEnv();
    vi.mocked(isPrivateUrl).mockReset();
    vi.mocked(isPrivateUrl).mockResolvedValue(false);
  });

  it("drives register → authorize → token → SDK initialize → serverInfo.name === 'browsermatic'", async () => {
    // 1. Walk the OAuth setup with direct handler calls (the same path
    //    oauth-e2e.test.ts uses). After this we have a real access_token
    //    sitting in `token:<access_token>` in our in-memory KV shim.
    const setup = await runOAuthSetup(shim);
    expect(setup.client.clientId).toMatch(UUID_RE);
    expect(setup.client.clientSecret).toMatch(BASE64URL_RE);
    expect(setup.accessToken).toMatch(BASE64URL_RE);

    // Sanity: the access token resolved through our env shim is exactly
    // the one the SDK will present at /mcp.
    const stored = JSON.parse(
      shim.kvStore.get(`token:${setup.accessToken}`)!,
    ) as AccessToken;
    expect(stored.userSessionToken).toBe(setup.sessionToken);
    expect(stored.clientId).toBe(setup.client.clientId);

    // 2. Construct the SDK client + transport pointed at our Worker.
    const fetchViaWorker = makeWorkerFetch(shim);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${WORKER_ORIGIN}/mcp`),
      {
        fetch: fetchViaWorker,
        // The SDK merges `requestInit.headers` into every request it sends
        // via `_commonHeaders()`. We do NOT provide an `authProvider` —
        // driving the OAuth flow ourselves is the whole point of this
        // test; we don't want the SDK attempting its own OAuth dance.
        requestInit: {
          headers: {
            Authorization: `Bearer ${setup.accessToken}`,
          },
        },
      },
    );
    const client = new Client(
      { name: "sdk-e2e-test-client", version: "0.0.0" },
      { capabilities: {} },
    );

    // 3. The moment of truth: connect() sends `initialize`, parses the
    //    result against InitializeResultSchema, sends
    //    `notifications/initialized`, and populates getServerVersion().
    await client.connect(transport);

    const serverInfo = client.getServerVersion();
    expect(serverInfo).toBeDefined();
    expect(serverInfo!.name).toBe("browsermatic");
    expect(serverInfo!.version).toBe("0.1.0");

    // 4. Clean shutdown. close() aborts the SDK's internal AbortController
    //    and fires onclose; the Worker doesn't need to do anything special.
    await client.close();
  });

  it("rejects an unresolvable bearer at /mcp — the SDK throws before it ever sees an initialize result", async () => {
    // The OAuth setup is a no-op here — we never get a real access_token.
    // We hand the SDK a bearer (the same shape — 43 base64url chars) that
    // has no corresponding KV row, so resolveMcpToken returns null and
    // /mcp returns 401. The SDK's transport wraps the 401 in a
    // StreamableHTTPError and connect() re-throws it.
    const fetchViaWorker = makeWorkerFetch(shim);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${WORKER_ORIGIN}/mcp`),
      {
        fetch: fetchViaWorker,
        requestInit: {
          headers: {
            // Plausible-shaped bearer that the bridge will try to look up —
            // and fail.
            Authorization: `Bearer ${"a".repeat(43)}`,
          },
        },
      },
    );
    const client = new Client(
      { name: "sdk-e2e-unknown-bearer", version: "0.0.0" },
      { capabilities: {} },
    );

    await expect(client.connect(transport)).rejects.toThrow();
    // Server version is never populated — the handshake never completed.
    expect(client.getServerVersion()).toBeUndefined();
  });

  it("rejects an expired access token at /mcp — manually mutating expiresAt flips the bridge to 401", async () => {
    // Set up a real access token, then mutate the stored KV row to claim
    // it expired an hour ago. The bridge's second-line defense
    // (resolveMcpToken's `Date.now() >= tok.expiresAt` check) treats it as
    // unresolvable, /mcp returns 401, SDK throws.
    const setup = await runOAuthSetup(shim);

    const tokenKey = `token:${setup.accessToken}`;
    const stored = JSON.parse(shim.kvStore.get(tokenKey)!) as AccessToken;
    stored.expiresAt = Date.now() - 60 * 60 * 1000; // 1 hour ago
    shim.kvStore.set(tokenKey, JSON.stringify(stored));

    const fetchViaWorker = makeWorkerFetch(shim);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${WORKER_ORIGIN}/mcp`),
      {
        fetch: fetchViaWorker,
        requestInit: {
          headers: { Authorization: `Bearer ${setup.accessToken}` },
        },
      },
    );
    const client = new Client(
      { name: "sdk-e2e-expired", version: "0.0.0" },
      { capabilities: {} },
    );

    await expect(client.connect(transport)).rejects.toThrow();
    expect(client.getServerVersion()).toBeUndefined();
  });

  it("rejects a token exchange with the wrong client_id — code minted for A, exchanged by B → invalid_grant", async () => {
    // Register TWO clients. Mint a code for client A. Try to redeem it
    // using client B's credentials. The handler's
    // `authCode.clientId !== client.clientId` check fires and returns
    // 400 invalid_grant. No SDK call required for this one — the test
    // lives entirely on the OAuth side and proves the cross-client
    // binding holds before the SDK even gets near /mcp.
    const clientA = (await (await handleRegister(
      jsonReq(`${WORKER_ORIGIN}/oauth/register`, {
        redirect_uris: [REDIRECT_URI],
        client_name: "clientA",
      }),
      shim.env,
    )).json()) as OAuthClientRegistration;
    const clientB = (await (await handleRegister(
      jsonReq(`${WORKER_ORIGIN}/oauth/register`, {
        redirect_uris: [REDIRECT_URI],
        client_name: "clientB",
      }),
      shim.env,
    )).json()) as OAuthClientRegistration;
    expect(clientA.clientId).not.toBe(clientB.clientId);

    const sessionToken = await mintSession(shim);

    const authorizeRes = await handleAuthorize(
      formReq(`${WORKER_ORIGIN}/oauth/authorize`, {
        response_type: "code",
        client_id: clientA.clientId,
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

    // Now attempt to redeem with client B's credentials. The PKCE
    // verifier is the right one (it's bound to the code, not the
    // client), so the test really is about the client mismatch — not
    // about the verifier.
    const badExchange = await handleToken(
      formReq(`${WORKER_ORIGIN}/oauth/token`, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
        client_id: clientB.clientId,
        client_secret: clientB.clientSecret,
      }),
      shim.env,
    );
    expect(badExchange.status).toBe(400);
    const badBody = (await badExchange.json()) as { error: string };
    expect(badBody.error).toBe("invalid_grant");

    // No KV rows for an access/refresh token were written by the failed
    // exchange — only the consume-side bookkeeping is allowed to fire.
    // (The DO's /consume DID run, which is why the original code is now
    // marked used; re-exchanging it with the right client would also
    // fail with invalid_grant, but that's tested in oauth-e2e.test.ts.)
    expect(shim.kvStore.size).toBe(0);
  });
});
