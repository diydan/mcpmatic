import { describe, expect, it, vi } from "vitest";

vi.mock("../worker/is-private-url", () => ({
  isPrivateUrl: vi.fn(async () => false),
}));
vi.mock("../worker/doh-resolve4", () => ({ makeResolve4: () => async () => [] }));

import { handleSite } from "../worker/site-routes";
import { isPrivateUrl } from "../worker/is-private-url";

const ORIGIN = "https://www.allbirds.com";
const TOKEN = "a".repeat(64);

function makeEnv(over: Partial<Record<string, unknown>> = {}) {
  const site = {
    issueToken: vi.fn(async () => ({ token: TOKEN })),
    expectedToken: vi.fn(async () => TOKEN),
    markVerified: vi.fn(async () => {}),
    authorises: vi.fn(async () => true),
    summary: vi.fn(async () => [
      { tool: "update_cart", calls: 3, ok: 1, failed: 2, reasons: { "schema-mismatch": 2 }, p50ms: 200 },
    ]),
    ...over,
  };
  return { env: { SITE: { getByName: vi.fn(() => site) } } as unknown as Env, site };
}

const post = (sub: string, body: unknown) =>
  new Request(`https://worker.test/site/${sub}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("site telemetry is gated on proving control of the origin", () => {
  it("refuses a read with no token", async () => {
    const { env } = makeEnv();
    const res = await handleSite(
      new Request(`https://worker.test/site/telemetry?origin=${ORIGIN}`),
      env,
      "telemetry",
    );
    expect(res.status).toBe(400);
  });

  it("refuses a read the site does not authorise", async () => {
    const { env } = makeEnv({ authorises: vi.fn(async () => false) });
    const res = await handleSite(
      new Request(`https://worker.test/site/telemetry?origin=${ORIGIN}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      env,
      "telemetry",
    );
    expect(res.status).toBe(401);
  });

  it("returns the per-tool summary to an authorised owner", async () => {
    const { env } = makeEnv();
    const res = await handleSite(
      new Request(`https://worker.test/site/telemetry?origin=${ORIGIN}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      env,
      "telemetry",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ tool: string }> };
    expect(body.tools[0].tool).toBe("update_cart");
  });

  it("verifies by reading the token the owner published", async () => {
    const { env, site } = makeEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(`${TOKEN}\n`));
    const res = await handleSite(post("verify/finish", { origin: ORIGIN }), env, "verify/finish");
    expect(res.status).toBe(200);
    expect(site.markVerified).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      `${ORIGIN}/.well-known/browsermatic.txt`,
      expect.anything(),
    );
    fetchSpy.mockRestore();
  });

  it("does not verify when the published token does not match", async () => {
    const { env, site } = makeEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("b".repeat(64)));
    const res = await handleSite(post("verify/finish", { origin: ORIGIN }), env, "verify/finish");
    expect(res.status).toBe(400);
    expect(site.markVerified).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("runs the SSRF guard before fetching the origin", async () => {
    // Whoever initiated it. An origin the caller names is still a navigation.
    //
    // Asserting the 400 alone proves nothing: with the guard removed the real
    // fetch fails and returns 400 too. What must be true is that no request
    // left this worker at all.
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(TOKEN));
    const { env, site } = makeEnv();
    const res = await handleSite(post("verify/finish", { origin: ORIGIN }), env, "verify/finish");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(site.markVerified).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
