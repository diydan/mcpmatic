/**
 * @vitest-environment node
 *
 * Worker entry-point route wiring. Confirms that `worker/index.ts` dispatches
 * each path to the correct handler. The handler bodies themselves are
 * covered by the dedicated handler tests; this file is a guard against
 * accidental mis-wiring (e.g. forgetting to add a new route, or pointing
 * `/oauth/authorize` at the register handler).
 *
 * Strategy: import the default-exported fetch handler, and stub out every
 * handler module it dynamically imports. Each stub captures the request it
 * was called with so the test can assert the path matches and that the
 * returned response is the one the caller sees. The stubs are wired into
 * an env shim that records DO lookups so we can confirm /sessions uses
 * SESSION, /oauth/register uses OAUTH_CLIENT, etc.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// All vi.mock factories are hoisted to the top of the file, so they
// cannot reference module-scoped bindings. Define the stubs INSIDE the
// factory and expose them via the mock module's exports.
vi.mock("../worker/oauth/register", () => {
  const handleRegister = vi.fn(async (req: Request) =>
    new Response(JSON.stringify({ stubbed: "register", url: req.url }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  );
  return { handleRegister };
});
vi.mock("../worker/oauth/authorize", () => {
  const handleAuthorize = vi.fn(async (req: Request) =>
    new Response(null, {
      status: 302,
      headers: {
        location: `https://stub.test/from-authorize?u=${encodeURIComponent(req.url)}`,
      },
    }),
  );
  return { handleAuthorize };
});
vi.mock("../worker/oauth/token", () => {
  const handleToken = vi.fn(async (req: Request) =>
    new Response(JSON.stringify({ stubbed: "token", url: req.url }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  return { handleToken };
});
vi.mock("../worker/mcp/server", () => {
  const handleMcp = vi.fn(async (req: Request) =>
    new Response(JSON.stringify({ stubbed: "mcp", url: req.url }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  return { handleMcp };
});
// The DO classes are re-exported from worker/index.ts so the runtime can
// instantiate them. They pull in `cloudflare:workers` (which the Node test
// env can't resolve), so stub them at the source.
vi.mock("../worker/session-do", () => ({ SessionDO: class SessionDO {} }));
vi.mock("../worker/oauth/client-do", () => ({
  OAuthClientDO: class OAuthClientDO {},
}));
vi.mock("../worker/oauth/code-do", () => ({
  OAuthCodeDO: class OAuthCodeDO {},
}));
vi.mock("../worker/account-do", () => ({ AccountDO: class AccountDO {} }));

// Pull the mocked handles AFTER the mocks are registered. Imports below
// this point (worker default export) refer to the mocked modules.
import { handleRegister } from "../worker/oauth/register";
import { handleAuthorize } from "../worker/oauth/authorize";
import { handleToken } from "../worker/oauth/token";
import { handleMcp } from "../worker/mcp/server";
import worker from "../worker/index";

// ------------------------------------------------------------------------

/**
 * Minimal env shim. The worker uses `env.SESSION.getByName(...)`,
 * `env.OAUTH_CLIENT.getByName(...)`, `env.OAUTH_CODE.getByName(...)` —
 * the routing tests never let the request reach a DO because every
 * branch of the dispatch returns before hitting storage. The shim records
 * the getByName calls so we can assert the worker only consults DOs from
 * the routes that need them.
 */
function makeEnv(): Env & {
  __claimAccount: ReturnType<typeof vi.fn>;
  __sessionGetByName: ReturnType<typeof vi.fn>;
  __oauthClientGetByName: ReturnType<typeof vi.fn>;
  __oauthCodeGetByName: ReturnType<typeof vi.fn>;
} {
  const claimAccount = vi.fn(async (_accountId: string) => ({
    ok: true,
    consent: ["https://www.allbirds.com"],
  }));
  const sessionGetByName = vi.fn((_name: string) => ({
    initSession: async (_token: string) => {},
    claimAccount,
    fetch: async (_req: Request) => new Response(null, { status: 200 }),
  }));
  const oauthClientGetByName = vi.fn((_name: string) => ({
    fetch: async (_req: Request) => new Response(null, { status: 200 }),
  }));
  const oauthCodeGetByName = vi.fn((_name: string) => ({
    fetch: async (_req: Request) => new Response(null, { status: 200 }),
  }));
  return {
    SESSION: { getByName: sessionGetByName },
    OAUTH_CLIENT: { getByName: oauthClientGetByName },
    OAUTH_CODE: { getByName: oauthCodeGetByName },
    __sessionGetByName: sessionGetByName,
    __claimAccount: claimAccount,
    __oauthClientGetByName: oauthClientGetByName,
    __oauthCodeGetByName: oauthCodeGetByName,
  } as unknown as Env & {
    __claimAccount: ReturnType<typeof vi.fn>;
    __sessionGetByName: ReturnType<typeof vi.fn>;
    __oauthClientGetByName: ReturnType<typeof vi.fn>;
    __oauthCodeGetByName: ReturnType<typeof vi.fn>;
  };
}

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

beforeEach(() => {
  handleRegister.mockClear();
  handleAuthorize.mockClear();
  handleToken.mockClear();
  handleMcp.mockClear();
});

// ------------------------------------------------------------------------

describe("worker/index.ts — route wiring", () => {
  it("POST /sessions creates a session (returns JSON with sessionToken)", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", { method: "POST" }),
      env as unknown as Env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string; url: string };
    expect(body.sessionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(body.url).toBe(`https://worker.local/s/${body.sessionToken}`);
    // /sessions MUST plant the sentinel row by calling initSession on the
    // SESSION DO — without it the OAuth authorize handler's /check would
    // 404 for any token minted here.
    expect(env.__sessionGetByName).toHaveBeenCalledTimes(1);
  });

  it("POST /mcp dispatches to handleMcp", async () => {
    const res = await worker.fetch!(
      req("https://worker.local/mcp", { method: "POST", body: "{}" }),
      makeEnv() as unknown as Env,
    );
    expect(handleMcp).toHaveBeenCalledTimes(1);
    expect(handleRegister).not.toHaveBeenCalled();
    expect(handleAuthorize).not.toHaveBeenCalled();
    expect(handleToken).not.toHaveBeenCalled();
    // The stub echoes the URL back through JSON so we can confirm the
    // worker passed the original URL through unchanged.
    const body = (await res.json()) as { stubbed: string; url: string };
    expect(body.stubbed).toBe("mcp");
    expect(body.url).toBe("https://worker.local/mcp");
  });

  it("POST /oauth/register dispatches to handleRegister", async () => {
    const res = await worker.fetch!(
      req("https://worker.local/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://example.com/cb"] }),
      }),
      makeEnv() as unknown as Env,
    );
    expect(handleRegister).toHaveBeenCalledTimes(1);
    expect(handleAuthorize).not.toHaveBeenCalled();
    expect(handleToken).not.toHaveBeenCalled();
    expect(handleMcp).not.toHaveBeenCalled();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { stubbed: string };
    expect(body.stubbed).toBe("register");
  });

  it("GET /oauth/authorize dispatches to handleAuthorize (renders consent page)", async () => {
    const res = await worker.fetch!(
      req(
        "https://worker.local/oauth/authorize?response_type=code&client_id=x&redirect_uri=y&state=z&code_challenge=q&code_challenge_method=S256",
        { method: "GET" },
      ),
      makeEnv() as unknown as Env,
    );
    expect(handleAuthorize).toHaveBeenCalledTimes(1);
    expect(handleRegister).not.toHaveBeenCalled();
    expect(handleToken).not.toHaveBeenCalled();
    expect(handleMcp).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("from-authorize");
  });

  it("POST /oauth/authorize dispatches to handleAuthorize (consent decision)", async () => {
    const res = await worker.fetch!(
      req("https://worker.local/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "response_type=code&client_id=x&consent=approve",
      }),
      makeEnv() as unknown as Env,
    );
    expect(handleAuthorize).toHaveBeenCalledTimes(1);
    expect(handleRegister).not.toHaveBeenCalled();
    expect(handleToken).not.toHaveBeenCalled();
    expect(handleMcp).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
  });

  it("POST /oauth/token dispatches to handleToken", async () => {
    const res = await worker.fetch!(
      req("https://worker.local/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=x",
      }),
      makeEnv() as unknown as Env,
    );
    expect(handleToken).toHaveBeenCalledTimes(1);
    expect(handleRegister).not.toHaveBeenCalled();
    expect(handleAuthorize).not.toHaveBeenCalled();
    expect(handleMcp).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stubbed: string };
    expect(body.stubbed).toBe("token");
  });

  it("unknown /oauth/<sub> → 404 with facade headers", async () => {
    const res = await worker.fetch!(
      req("https://worker.local/oauth/unknown", { method: "POST" }),
      makeEnv() as unknown as Env,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(handleRegister).not.toHaveBeenCalled();
    expect(handleAuthorize).not.toHaveBeenCalled();
    expect(handleToken).not.toHaveBeenCalled();
  });

  it("non-POST /sessions is NOT routed to createSession (the worker guards method)", async () => {
    const res = await worker.fetch!(
      req("https://worker.local/sessions", { method: "GET" }),
      makeEnv() as unknown as Env,
    );
    expect(res.status).toBe(404);
  });

  it("unknown path → 404", async () => {
    const res = await worker.fetch!(
      req("https://worker.local/nope", { method: "POST" }),
      makeEnv() as unknown as Env,
    );
    expect(res.status).toBe(404);
  });
});
describe("POST /s/:token/account", () => {
  const TOKEN = "a".repeat(64);
  const ACCOUNT = "b".repeat(64);

  function post(body: unknown) {
    return new Request(`https://worker.local/s/${TOKEN}/account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("claims the session for the account and returns the inherited grants", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(post({ accountId: ACCOUNT }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      consent: ["https://www.allbirds.com"],
    });
    expect(env.__claimAccount).toHaveBeenCalledWith(ACCOUNT);
  });

  it("rejects a malformed account id without touching the DO", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(post({ accountId: "nope" }), env);
    expect(res.status).toBe(400);
    expect(env.__claimAccount).not.toHaveBeenCalled();
  });

  it("refuses a session already claimed by another account", async () => {
    const env = makeEnv();
    env.__claimAccount.mockResolvedValueOnce({
      ok: false,
      error: "claimed-by-another",
    });
    const res = await worker.fetch!(post({ accountId: ACCOUNT }), env);
    expect(res.status).toBe(409);
  });
});
