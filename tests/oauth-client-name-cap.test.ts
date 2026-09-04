import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression coverage for the clientName input cap (audit §1.7 in
 * task-1-report.md). Before the fix, `worker/oauth/register.ts` accepted
 * any string and stored it verbatim in OAuthClientDO — a 1 MB body would
 * cost 1 MB of durable storage per registration.
 *
 * After the fix:
 *   - explicitly empty or whitespace-only `client_name` → 400 invalid_request.
 *   - a `client_name` longer than 200 chars is clamped to the first 200
 *     chars (truncation, not rejection — the brief's wording is "clamp").
 *   - missing / non-string `client_name` still defaults to "unnamed".
 *   - at most 200 chars and non-empty after trim → stored verbatim
 *     (trimmed of leading/trailing whitespace? — see implementation note).
 */

vi.mock("../worker/is-private-url", () => ({
  isPrivateUrl: vi.fn().mockResolvedValue(false),
}));
vi.mock("../worker/doh-resolve4", () => ({
  makeResolve4: () => async () => [] as string[],
}));

import { handleRegister } from "../worker/oauth/register";

type FetchMock = ReturnType<typeof vi.fn>;

function makeEnv() {
  const doFetch = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValue(new Response(null, { status: 200 }));
  const getByName = vi
    .fn<(name: string) => { fetch: FetchMock }>()
    .mockReturnValue({ fetch: doFetch });
  const env = {
    OAUTH_CLIENT: { getByName },
  } as unknown as Env;
  return { env, doFetch, getByName };
}

function req(body: unknown): Request {
  return new Request("https://worker.local/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const MAX_NAME_LEN = 200;

describe("handleRegister — client_name input cap", () => {
  let shim: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    shim = makeEnv();
  });

  it("missing client_name still defaults to 'unnamed'", async () => {
    const res = await handleRegister(
      req({ redirect_uris: ["https://example.com/cb"] }),
      shim.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { clientName: string };
    expect(body.clientName).toBe("unnamed");
  });

  it("accepts a normal-length client_name verbatim", async () => {
    const res = await handleRegister(
      req({
        redirect_uris: ["https://example.com/cb"],
        client_name: "my-cool-agent",
      }),
      shim.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { clientName: string };
    expect(body.clientName).toBe("my-cool-agent");
  });

  it("rejects empty-string client_name with 400 invalid_request", async () => {
    const res = await handleRegister(
      req({
        redirect_uris: ["https://example.com/cb"],
        client_name: "",
      }),
      shim.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    // DO must NOT be touched on validation failure.
    expect(shim.getByName).not.toHaveBeenCalled();
    expect(shim.doFetch).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only client_name with 400 invalid_request", async () => {
    const res = await handleRegister(
      req({
        redirect_uris: ["https://example.com/cb"],
        client_name: "   \t\n  ",
      }),
      shim.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(shim.getByName).not.toHaveBeenCalled();
  });

  it("accepts a client_name of exactly MAX_NAME_LEN chars", async () => {
    const name = "a".repeat(MAX_NAME_LEN);
    const res = await handleRegister(
      req({
        redirect_uris: ["https://example.com/cb"],
        client_name: name,
      }),
      shim.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { clientName: string };
    expect(body.clientName).toHaveLength(MAX_NAME_LEN);
    expect(body.clientName).toBe(name);
  });

  it("clamps a client_name of MAX_NAME_LEN+1 chars to the first MAX_NAME_LEN", async () => {
    const long = "a".repeat(MAX_NAME_LEN + 1);
    const res = await handleRegister(
      req({
        redirect_uris: ["https://example.com/cb"],
        client_name: long,
      }),
      shim.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { clientName: string };
    expect(body.clientName).toHaveLength(MAX_NAME_LEN);
    expect(body.clientName).toBe("a".repeat(MAX_NAME_LEN));
  });

  it("clamps a much longer client_name (1 KB) to MAX_NAME_LEN", async () => {
    const huge = "x".repeat(1024);
    const res = await handleRegister(
      req({
        redirect_uris: ["https://example.com/cb"],
        client_name: huge,
      }),
      shim.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { clientName: string };
    expect(body.clientName).toHaveLength(MAX_NAME_LEN);
  });

  it("the DO receives the clamped clientName, not the original input", async () => {
    const huge = "y".repeat(MAX_NAME_LEN + 50);
    const res = await handleRegister(
      req({
        redirect_uris: ["https://example.com/cb"],
        client_name: huge,
      }),
      shim.env,
    );
    expect(res.status).toBe(201);
    const [, init] = shim.doFetch.mock.calls[0] as [
      string,
      RequestInit | undefined,
    ];
    const persisted = JSON.parse(init!.body as string) as { clientName: string };
    expect(persisted.clientName).toHaveLength(MAX_NAME_LEN);
    expect(persisted.clientName).toBe("y".repeat(MAX_NAME_LEN));
  });
});
