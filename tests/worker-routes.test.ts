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
vi.mock("../worker/passkey-routes", () => {
  const handlePasskey = vi.fn(async (req: Request, _e: unknown, sub: string) =>
    new Response(JSON.stringify({ stubbed: "passkey", sub, url: req.url }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  return { handlePasskey };
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
vi.mock("../worker/site-do", () => ({ SiteDO: class SiteDO {} }));

// Pull the mocked handles AFTER the mocks are registered. Imports below
// this point (worker default export) refer to the mocked modules.
import { handleRegister } from "../worker/oauth/register";
import { handleAuthorize } from "../worker/oauth/authorize";
import { handleToken } from "../worker/oauth/token";
import { handleMcp } from "../worker/mcp/server";
import { SESSION_TOKEN_RE } from "../shared/session-token";
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
  __claimAccountWithStepUp: ReturnType<typeof vi.fn>;
  __revokeConsent: ReturnType<typeof vi.fn>;
  __grantConsent: ReturnType<typeof vi.fn>;
  __listConsent: ReturnType<typeof vi.fn>;
  __listHistory: ReturnType<typeof vi.fn>;
  __sessionGetByName: ReturnType<typeof vi.fn>;
  __oauthClientGetByName: ReturnType<typeof vi.fn>;
  __oauthCodeGetByName: ReturnType<typeof vi.fn>;
} {
  const claimAccount = vi.fn(async (_accountId: string) => ({
    ok: true,
    consent: ["https://www.allbirds.com"],
  }));
  const claimAccountWithStepUp = vi.fn(
    async (_accountId: string, _stepUpToken: string) => ({
      ok: true as const,
      consent: ["https://www.allbirds.com"],
    }),
  );
  const revokeConsent = vi.fn(async (_origin: string) => ({
    ok: true,
    consent: [],
  }));
  const grantConsent = vi.fn(async (_origin: string) => ({ ok: true }));
  const listConsent = vi.fn(async () => ({
    consent: ["https://www.allbirds.com"],
    autonomous: false,
  }));
  const listHistory = vi.fn(async () => [
    {
      origin: "https://www.allbirds.com",
      tool: "fill_checkout_on_allbirds_com",
      fieldNames: ["address.line1"],
      timestamp: 1,
    },
  ]);
  const sessionGetByName = vi.fn((_name: string) => ({
    initSession: async (_token: string) => {},
    claimAccount,
    claimAccountWithStepUp,
    revokeConsent,
    grantConsent,
    listConsent,
    listHistory,
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
    __claimAccountWithStepUp: claimAccountWithStepUp,
    __revokeConsent: revokeConsent,
    __grantConsent: grantConsent,
    __listConsent: listConsent,
    __listHistory: listHistory,
    __oauthClientGetByName: oauthClientGetByName,
    __oauthCodeGetByName: oauthCodeGetByName,
  } as unknown as Env & {
    __claimAccount: ReturnType<typeof vi.fn>;
    __claimAccountWithStepUp: ReturnType<typeof vi.fn>;
    __revokeConsent: ReturnType<typeof vi.fn>;
    __grantConsent: ReturnType<typeof vi.fn>;
    __listConsent: ReturnType<typeof vi.fn>;
    __listHistory: ReturnType<typeof vi.fn>;
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
    expect(body.sessionToken).toMatch(SESSION_TOKEN_RE);
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
  const STEP_UP = "c".repeat(64);

  function post(body: unknown) {
    return new Request(`https://worker.local/s/${TOKEN}/account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("claims the session for the account and returns the inherited grants", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(
      post({ accountId: ACCOUNT, stepUpToken: STEP_UP }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      consent: ["https://www.allbirds.com"],
    });
    expect(env.__claimAccountWithStepUp).toHaveBeenCalledWith(ACCOUNT, STEP_UP);
  });

  it("rejects a malformed account id without touching the DO", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(
      post({ accountId: "nope", stepUpToken: STEP_UP }),
      env,
    );
    expect(res.status).toBe(400);
    expect(env.__claimAccountWithStepUp).not.toHaveBeenCalled();
  });

  it("rejects a missing stepUpToken — the session URL alone no longer claims", async () => {
    // The session token is a bearer credential in the URL: anyone who learned
    // it could claim any account before step-up existed. The route must say
    // so in the response, not silently 200 an unverified claim.
    const env = makeEnv();
    const res = await worker.fetch!(post({ accountId: ACCOUNT }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: "step-up required",
    });
    expect(env.__claimAccountWithStepUp).not.toHaveBeenCalled();
  });

  it("rejects an empty stepUpToken for the same reason", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(
      post({ accountId: ACCOUNT, stepUpToken: "" }),
      env,
    );
    expect(res.status).toBe(400);
    expect(env.__claimAccountWithStepUp).not.toHaveBeenCalled();
  });

  it("answers 401 when the DO rejects the step-up token", async () => {
    const env = makeEnv();
    env.__claimAccountWithStepUp.mockResolvedValueOnce({
      ok: false,
      error: "step-up invalid",
    });
    const res = await worker.fetch!(
      post({ accountId: ACCOUNT, stepUpToken: STEP_UP }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      ok: false,
      error: "step-up invalid",
    });
  });
});

describe("DELETE /s/:token/consent", () => {
  const TOKEN = "a".repeat(64);

  function del(body: unknown) {
    return new Request(`https://worker.local/s/${TOKEN}/consent`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("revokes the origin and returns the remaining consent list", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(
      del({ origin: "https://www.allbirds.com" }),
      env as unknown as Env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, consent: [] });
    expect(env.__revokeConsent).toHaveBeenCalledWith(
      "https://www.allbirds.com",
    );
  });

  it("rejects a non-https origin without touching the DO", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(del({ origin: "http://x.com" }), env);
    expect(res.status).toBe(400);
    expect(env.__revokeConsent).not.toHaveBeenCalled();
  });

  it("rejects an unparseable origin without touching the DO", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(del({ origin: "not a url" }), env);
    expect(res.status).toBe(400);
    expect(env.__revokeConsent).not.toHaveBeenCalled();
  });
});

describe("consent routes — session expiry (P1.2)", () => {
  const TOKEN = "a".repeat(64);
  const expiredErr = new Error("session expired");

  function expiredEnv(): Env & {
    __revokeConsent: ReturnType<typeof vi.fn>;
    __grantConsent: ReturnType<typeof vi.fn>;
    __listConsent: ReturnType<typeof vi.fn>;
  } {
    const env = makeEnv();
    env.__revokeConsent.mockRejectedValue(expiredErr);
    env.__grantConsent.mockRejectedValue(expiredErr);
    env.__listConsent.mockRejectedValue(expiredErr);
    return env as unknown as typeof env;
  }

  it("POST /s/:token/consent answers 410 on an expired session", async () => {
    const env = expiredEnv();
    const res = await worker.fetch!(
      new Request(`https://worker.local/s/${TOKEN}/consent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "https://www.allbirds.com" }),
      }),
      env as unknown as Env,
    );
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ ok: false, error: "session expired" });
  });

  it("DELETE /s/:token/consent answers 410 on an expired session", async () => {
    const env = expiredEnv();
    const res = await worker.fetch!(
      new Request(`https://worker.local/s/${TOKEN}/consent`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "https://www.allbirds.com" }),
      }),
      env as unknown as Env,
    );
    expect(res.status).toBe(410);
  });

  it("GET /s/:token/consent answers 410 on an expired session", async () => {
    const env = expiredEnv();
    const res = await worker.fetch!(
      new Request(`https://worker.local/s/${TOKEN}/consent`),
      env as unknown as Env,
    );
    expect(res.status).toBe(410);
  });

  it("an unexpected DO error is not swallowed as expiry", async () => {
    const env = makeEnv();
    env.__grantConsent.mockRejectedValue(new Error("storage down"));
    // The worker rethrows what it cannot classify; the runtime turns that
    // into a 500. Assert the rejection escapes rather than asserting a
    // status the worker itself never produces.
    await expect(
      worker.fetch!(
        new Request(`https://worker.local/s/${TOKEN}/consent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ origin: "https://www.allbirds.com" }),
        }),
        env as unknown as Env,
      ),
    ).rejects.toThrow("storage down");
  });
});

describe("GET /s/:token/audit", () => {
  const TOKEN = "a".repeat(64);

  it("returns the durable log the account holds", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(
      new Request(`https://worker.local/s/${TOKEN}/audit`),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [
        {
          origin: "https://www.allbirds.com",
          tool: "fill_checkout_on_allbirds_com",
          fieldNames: ["address.line1"],
          timestamp: 1,
        },
      ],
    });
    expect(env.__listHistory).toHaveBeenCalled();
  });

  it("does not accept a write", async () => {
    const env = makeEnv();
    const res = await worker.fetch!(
      new Request(`https://worker.local/s/${TOKEN}/audit`, { method: "POST" }),
      env,
    );
    expect(res.status).toBe(404);
    expect(env.__listHistory).not.toHaveBeenCalled();
  });
});

describe("/account/passkey/*", () => {
  it("dispatches each ceremony step to the passkey handler", async () => {
    const { handlePasskey } = await import("../worker/passkey-routes");
    for (const sub of [
      "register/options",
      "register/verify",
      "login/options",
      "login/verify",
    ]) {
      const res = await worker.fetch!(
        new Request(`https://worker.local/account/passkey/${sub}`, {
          method: "POST",
        }),
        makeEnv(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ stubbed: "passkey", sub });
    }
    expect(handlePasskey).toHaveBeenCalledTimes(4);
  });

  it("404s an unknown account path without calling the handler", async () => {
    const { handlePasskey } = await import("../worker/passkey-routes");
    vi.mocked(handlePasskey).mockClear();
    const res = await worker.fetch!(
      new Request("https://worker.local/account/nope", { method: "POST" }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(handlePasskey).not.toHaveBeenCalled();
  });
});
