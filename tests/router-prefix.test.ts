/**
 * @vitest-environment node
 *
 * Router prefix anchoring (2026-09-04 review, L4).
 *
 * `worker/index.ts` dispatches three families of routes by prefix. A bare
 * `startsWith("/site/")` is loose in both directions: it never matches the
 * family's own root (`/site`), and reading it invites the belief that
 * `/siteFoo` is handled here too. This file pins both halves — the anchored
 * form routes `/site`, `/account/passkey` and `/oauth` into their handlers
 * (which answer 404 for an empty sub, as they do for any unknown one), and
 * a neighbouring path that merely shares the prefix's characters
 * (`/siteFoo`, `/account/passkeyfoo`, `/oauth2`) never reaches a handler at
 * all.
 *
 * Same strategy as worker-routes.test.ts: stub every dynamically imported
 * handler module, then drive the default fetch export. The stubs mirror the
 * real handlers' one behaviour this file depends on — an unknown sub is a
 * 404, not a throw.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../worker/site-routes", () => {
  const handleSite = vi.fn(async (_req: Request, _e: unknown, sub: string) =>
    sub === "telemetry"
      ? new Response(JSON.stringify({ stubbed: "site", sub }), { status: 200 })
      : new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
  );
  return { handleSite };
});
vi.mock("../worker/passkey-routes", () => {
  const handlePasskey = vi.fn(async (_req: Request, _e: unknown, sub: string) =>
    sub === "login/options"
      ? new Response(JSON.stringify({ stubbed: "passkey", sub }), { status: 200 })
      : new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
  );
  return { handlePasskey };
});
vi.mock("../worker/oauth/register", () => ({
  handleRegister: vi.fn(async () => new Response("{}", { status: 201 })),
}));
vi.mock("../worker/oauth/authorize", () => ({
  handleAuthorize: vi.fn(async () => new Response(null, { status: 302 })),
}));
vi.mock("../worker/oauth/token", () => ({
  handleToken: vi.fn(async () => new Response("{}", { status: 200 })),
}));
vi.mock("../worker/mcp/server", () => ({
  handleMcp: vi.fn(async () => new Response("{}", { status: 200 })),
}));
// The DO classes are re-exported from worker/index.ts and pull in
// `cloudflare:workers`, which the Node test env cannot resolve.
vi.mock("../worker/session-do", () => ({ SessionDO: class SessionDO {} }));
vi.mock("../worker/oauth/client-do", () => ({
  OAuthClientDO: class OAuthClientDO {},
}));
vi.mock("../worker/oauth/code-do", () => ({
  OAuthCodeDO: class OAuthCodeDO {},
}));
vi.mock("../worker/account-do", () => ({ AccountDO: class AccountDO {} }));
vi.mock("../worker/site-do", () => ({ SiteDO: class SiteDO {} }));

import { handleSite } from "../worker/site-routes";
import { handlePasskey } from "../worker/passkey-routes";
import { handleRegister } from "../worker/oauth/register";
import { handleAuthorize } from "../worker/oauth/authorize";
import { handleToken } from "../worker/oauth/token";
import worker from "../worker/index";

/** The routes under test never reach a DO; the shim only has to exist. */
function makeEnv(): Env {
  return {
    SESSION: { getByName: vi.fn(() => ({})) },
    OAUTH_CLIENT: { getByName: vi.fn(() => ({})) },
    OAUTH_CODE: { getByName: vi.fn(() => ({})) },
  } as unknown as Env;
}

function get(path: string): Promise<Response> {
  return worker.fetch!(
    new Request(`https://worker.local${path}`),
    makeEnv(),
    {} as ExecutionContext,
  );
}

beforeEach(() => {
  vi.mocked(handleSite).mockClear();
  vi.mocked(handlePasskey).mockClear();
  vi.mocked(handleRegister).mockClear();
  vi.mocked(handleAuthorize).mockClear();
  vi.mocked(handleToken).mockClear();
});

describe("worker/index.ts — prefix routes are anchored", () => {
  it("/siteFoo is not a /site route", async () => {
    const res = await get("/siteFoo");
    expect(res.status).toBe(404);
    expect(handleSite).not.toHaveBeenCalled();
  });

  it("/account/passkeyfoo is not a passkey route", async () => {
    const res = await get("/account/passkeyfoo");
    expect(res.status).toBe(404);
    expect(handlePasskey).not.toHaveBeenCalled();
  });

  it("/oauth2 is not an OAuth route", async () => {
    const res = await get("/oauth2");
    expect(res.status).toBe(404);
    expect(handleRegister).not.toHaveBeenCalled();
    expect(handleAuthorize).not.toHaveBeenCalled();
    expect(handleToken).not.toHaveBeenCalled();
  });

  it("the family roots reach their handler with an empty sub, and 404 there", async () => {
    expect((await get("/site")).status).toBe(404);
    expect(handleSite).toHaveBeenCalledWith(expect.anything(), expect.anything(), "");
    expect((await get("/account/passkey")).status).toBe(404);
    expect(handlePasskey).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "",
    );
    // /oauth's sub-dispatch is inline in the router, so an empty sub is its
    // own 404 rather than a handler's.
    expect((await get("/oauth")).status).toBe(404);
    expect(handleRegister).not.toHaveBeenCalled();
  });

  it("real sub-paths still dispatch", async () => {
    expect((await get("/site/telemetry")).status).toBe(200);
    expect(handleSite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "telemetry",
    );
    expect((await get("/account/passkey/login/options")).status).toBe(200);
    expect((await get("/oauth/token")).status).toBe(200);
    expect(handleToken).toHaveBeenCalledTimes(1);
  });
});
