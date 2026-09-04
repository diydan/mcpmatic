import { describe, expect, it, vi, beforeEach } from "vitest";

import { handleAuthorize } from "../worker/oauth/authorize";
import type { AuthCode, OAuthClient } from "../worker/oauth/types";

/**
 * handleAuthorize reaches into three Durable Object namespaces:
 *   - OAUTH_CLIENT.getByName(clientId).fetch("/get") to validate the client
 *   - OAUTH_CODE.getByName(code).fetch("/issue", POST body) to persist code
 *   - SESSION.getByName(sessionToken).fetch("/check") to verify the token
 *     actually corresponds to a created session — without this, a pasted
 *     random string would mint an OAuth code bound to a chosen token.
 *
 * The tests build an env shim that stubs `getByName` for all three
 * bindings. The SESSION check is only consulted on the POST decision path.
 */

type FetchMock = ReturnType<typeof vi.fn>;

interface EnvShim {
  env: Env;
  clientGetByName: FetchMock;
  clientFetch: FetchMock;
  codeGetByName: FetchMock;
  codeFetch: FetchMock;
  sessionGetByName: FetchMock;
  sessionFetch: FetchMock;
}

function makeEnv(
  initialClients: Record<string, OAuthClient> = {},
  initialSessions: Record<string, true> = {},
): EnvShim {
  const clients = new Map<string, OAuthClient>(
    Object.entries(initialClients),
  );
  const sessions = new Map<string, true>(Object.entries(initialSessions));

  // The DO ignores the URL, but in our shim the id is known only via the
  // getByName call. We resolve it from these Maps by tracking the LAST
  // id returned by getByName before each fetch invocation.
  let lastClientId: string | undefined = undefined;
  let lastSessionId: string | undefined = undefined;

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
    .mockResolvedValue(Response.json({ ok: true }));
  const codeGetByName = vi
    .fn<(name: string) => { fetch: FetchMock }>()
    .mockReturnValue({ fetch: codeFetch });

  const sessionFetch = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.pathname === "/check") {
        const id = lastSessionId ?? "";
        return sessions.has(id)
          ? Response.json({ ok: true })
          : new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });
  const sessionGetByName = vi
    .fn<(name: string) => { fetch: FetchMock }>()
    .mockImplementation((name: string) => {
      lastSessionId = name;
      return { fetch: sessionFetch };
    });

  const env = {
    OAUTH_CLIENT: { getByName: clientGetByName },
    OAUTH_CODE: { getByName: codeGetByName },
    SESSION: { getByName: sessionGetByName },
  } as unknown as Env;

  return {
    env,
    clientGetByName,
    clientFetch,
    codeGetByName,
    codeFetch,
    sessionGetByName,
    sessionFetch,
  };
}

const SESSION_TOKEN = "a".repeat(64);

const VALID_PARAMS = {
  client_id: "client-abc",
  redirect_uri: "https://example.com/cb",
  state: "state-token-xyz",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  response_type: "code",
  session_token: SESSION_TOKEN,
};

function req(params: Record<string, string>): Request {
  const qs = new URLSearchParams(params).toString();
  return new Request(`https://worker.local/oauth/authorize?${qs}`, { method: "GET" });
}

function postReq(params: Record<string, string>): Request {
  const body = new URLSearchParams(params).toString();
  return new Request("https://worker.local/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

const CLIENT: OAuthClient = {
  clientId: "client-abc",
  // Placeholder hash — authorize never reads the secret.
  clientSecretHash: "sha256:placeholder-hash-here-00000000000000000000000000000000000000000000000000",
  redirectUris: ["https://example.com/cb", "https://example.com/cb?x=1"],
  clientName: "test client",
  createdAt: 1700000000000,
};

const BASE64URL_RE = /^[A-Za-z0-9_\-]{43}$/;

describe("handleAuthorize (GET /oauth/authorize) — RFC 6749 §4.1.1 authorization code grant", () => {
  let shim: EnvShim;

  beforeEach(() => {
    shim = makeEnv({ "client-abc": CLIENT }, { [SESSION_TOKEN]: true });
  });

  it("happy path: POST consent=approve → 302 to redirect_uri with code + state; session verified, code persisted via OAuthCodeDO", async () => {
    const before = Date.now();
    const res = await handleAuthorize(
      postReq({ ...VALID_PARAMS, consent: "approve" }),
      shim.env,
    );
    const after = Date.now();

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();

    const target = new URL(location!);
    expect(target.origin + target.pathname).toBe("https://example.com/cb");
    expect(target.searchParams.get("state")).toBe("state-token-xyz");

    const code = target.searchParams.get("code");
    expect(code).not.toBeNull();
    expect(code!).toMatch(BASE64URL_RE);

    // Regression: session_token MUST NOT leak into the redirect URL.
    expect(target.searchParams.get("session_token")).toBeNull();

    // Session was verified before code issuance.
    expect(shim.sessionGetByName).toHaveBeenCalledTimes(1);
    expect(shim.sessionGetByName).toHaveBeenCalledWith(SESSION_TOKEN);
    expect(shim.sessionFetch).toHaveBeenCalledTimes(1);
    expect((shim.sessionFetch.mock.calls[0] as [string, RequestInit])[0]).toBe(
      "https://stub/check",
    );

    // DO issue call shape.
    expect(shim.codeGetByName).toHaveBeenCalledTimes(1);
    expect(shim.codeGetByName).toHaveBeenCalledWith(code);
    expect(shim.codeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = shim.codeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://stub/issue");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as AuthCode;
    expect(body.code).toBe(code);
    expect(body.clientId).toBe("client-abc");
    expect(body.userSessionToken).toBe(SESSION_TOKEN);
    expect(body.redirectUri).toBe("https://example.com/cb");
    expect(body.codeChallenge).toBe(VALID_PARAMS.code_challenge);
    expect(body.codeChallengeMethod).toBe("S256");
    expect(body.used).toBe(false);
    // expiresAt is ~10 minutes from now. Allow a small slack window.
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 100);
    expect(body.expiresAt).toBeLessThanOrEqual(after + 10 * 60 * 1000 + 100);

    // Client was fetched first.
    expect(shim.clientGetByName).toHaveBeenCalledWith("client-abc");
  });

  it("first visit (GET) → 200 text/html with a form POSTing back to /oauth/authorize and a session_token input", async () => {
    const { consent: _c, session_token: _s, ...firstVisit } = VALID_PARAMS;
    const res = await handleAuthorize(req(firstVisit), shim.env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);

    const html = await res.text();
    // Form posts back to the authorize endpoint with method=POST.
    expect(html).toMatch(/<form[^>]+action="\/oauth\/authorize"/);
    expect(html).toMatch(/method="post"/);
    // The two consent buttons.
    expect(html).toMatch(/name="consent"\s+value="approve"/);
    expect(html).toMatch(/name="consent"\s+value="deny"/);
    // The session_token form field.
    expect(html).toMatch(/name="session_token"/);
    // Echoes back the original client_id / redirect_uri / state /
    // code_challenge as hidden inputs so the form round-trips them.
    expect(html).toContain(`value="${VALID_PARAMS.client_id}"`);
    expect(html).toContain(`value="${VALID_PARAMS.redirect_uri}"`);
    expect(html).toContain(`value="${VALID_PARAMS.state}"`);
    expect(html).toContain(`value="${VALID_PARAMS.code_challenge}"`);
    expect(html).toContain(`value="S256"`);
    expect(html).toContain(`value="code"`);

    // First-visit GET never touches the session or code DOs — the user
    // hasn't pasted a token yet.
    expect(shim.sessionGetByName).not.toHaveBeenCalled();
    expect(shim.codeGetByName).not.toHaveBeenCalled();
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("denied consent (POST consent=deny) → 302 to redirect_uri with error=access_denied + state; no code issued", async () => {
    const res = await handleAuthorize(
      postReq({ ...VALID_PARAMS, consent: "deny" }),
      shim.env,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const target = new URL(location!);
    expect(target.origin + target.pathname).toBe("https://example.com/cb");
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("state-token-xyz");
    expect(target.searchParams.get("code")).toBeNull();
    // session_token MUST NOT leak.
    expect(target.searchParams.get("session_token")).toBeNull();

    // Critical: the code DO is NEVER touched on deny.
    expect(shim.codeGetByName).not.toHaveBeenCalled();
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("missing code_challenge → 400 invalid_request", async () => {
    const { code_challenge: _cc, ...withoutCC } = VALID_PARAMS;
    const res = await handleAuthorize(req(withoutCC), shim.env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(shim.clientGetByName).not.toHaveBeenCalled();
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("non-S256 method (plain) → 400 invalid_request mentioning PKCE S256", async () => {
    const res = await handleAuthorize(
      req({ ...VALID_PARAMS, code_challenge_method: "plain" }),
      shim.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/S256/);
    expect(shim.clientGetByName).not.toHaveBeenCalled();
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("invalid client_id (OAuthClientDO returns 404) → 400 invalid_client", async () => {
    const res = await handleAuthorize(
      req({ ...VALID_PARAMS, client_id: "unknown" }),
      shim.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("unregistered redirect_uri → 400 invalid_redirect_uri", async () => {
    const res = await handleAuthorize(
      req({ ...VALID_PARAMS, redirect_uri: "https://attacker.example/cb" }),
      shim.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("missing session_token after POST consent=approve → 400 invalid_request", async () => {
    const { session_token: _st, ...withoutToken } = VALID_PARAMS;
    const res = await handleAuthorize(
      postReq({ ...withoutToken, consent: "approve" }),
      shim.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/session_token/);
    // The session DO is never consulted when the field is missing.
    expect(shim.sessionGetByName).not.toHaveBeenCalled();
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("session_token not registered with SessionDO (returns 404 on /check) → 400 invalid_request; no code issued", async () => {
    const res = await handleAuthorize(
      postReq({ ...VALID_PARAMS, consent: "approve", session_token: "b".repeat(64) }),
      shim.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/not found/);
    // /check was called for the bogus token; the code DO is NEVER touched.
    expect(shim.sessionGetByName).toHaveBeenCalledWith("b".repeat(64));
    expect(shim.sessionFetch).toHaveBeenCalledTimes(1);
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("happy path with existing query string in redirect_uri (POST) → uses '&' separator", async () => {
    const res = await handleAuthorize(
      postReq({
        ...VALID_PARAMS,
        consent: "approve",
        redirect_uri: "https://example.com/cb?x=1",
      }),
      shim.env,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    expect(location).toMatch(/^https:\/\/example\.com\/cb\?/);
    const target = new URL(location!);
    expect(target.searchParams.get("x")).toBe("1");
    expect(target.searchParams.get("code")).not.toBeNull();
    expect(target.searchParams.get("state")).toBe("state-token-xyz");
    expect((location!.match(/\?/g) ?? []).length).toBe(1);
  });

  it("happy path: state with special characters is URL-encoded in the redirect target (POST)", async () => {
    const tricky = "a b/c?d=e&f=g";
    const res = await handleAuthorize(
      postReq({ ...VALID_PARAMS, consent: "approve", state: tricky }),
      shim.env,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const target = new URL(location!);
    expect(target.searchParams.get("state")).toBe(tricky);
  });

  it("denied consent with existing query string in redirect_uri (POST) → '&' separator and code NOT issued", async () => {
    const res = await handleAuthorize(
      postReq({
        ...VALID_PARAMS,
        redirect_uri: "https://example.com/cb?x=1",
        consent: "deny",
      }),
      shim.env,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const target = new URL(location!);
    expect(target.searchParams.get("x")).toBe("1");
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("code")).toBeNull();
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("GET with consent=approve (legacy client path) → 405 method not allowed", async () => {
    const res = await handleAuthorize(
      req({ ...VALID_PARAMS, consent: "approve" }),
      shim.env,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toMatch(/GET/);
    expect(res.headers.get("allow")).toMatch(/POST/);
    // 405 short-circuits before any DO call.
    expect(shim.clientGetByName).not.toHaveBeenCalled();
    expect(shim.sessionGetByName).not.toHaveBeenCalled();
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("non-GET/POST method (e.g. DELETE) → 405 method not allowed", async () => {
    const res = await handleAuthorize(
      new Request("https://worker.local/oauth/authorize", { method: "DELETE" }),
      shim.env,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toMatch(/GET/);
    expect(res.headers.get("allow")).toMatch(/POST/);
    expect(shim.clientGetByName).not.toHaveBeenCalled();
    expect(shim.codeFetch).not.toHaveBeenCalled();
  });

  it("consent page response carries Referrer-Policy: no-referrer and Cache-Control: no-store", async () => {
    const { consent: _c, session_token: _s, ...firstVisit } = VALID_PARAMS;
    const res = await handleAuthorize(req(firstVisit), shim.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("approve 302 carries Referrer-Policy: no-referrer and Cache-Control: no-store", async () => {
    const res = await handleAuthorize(
      postReq({ ...VALID_PARAMS, consent: "approve" }),
      shim.env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("deny 302 carries Referrer-Policy: no-referrer and Cache-Control: no-store", async () => {
    const res = await handleAuthorize(
      postReq({ ...VALID_PARAMS, consent: "deny" }),
      shim.env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
