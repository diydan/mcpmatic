import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the SSRF guard so the handler tests stay deterministic and do not
// depend on real DNS resolution. Per-test we choose whether the URL is
// accepted or rejected by `isPrivateUrl` (which is what the handler delegates
// to). The behavior of `isPrivateUrl` itself is covered by `tests/ssrf.test.ts`.
vi.mock("../worker/is-private-url", () => ({
  isPrivateUrl: vi.fn(),
}));

// Same idea for the resolver factory — `isPrivateUrl` is mocked, so the
// resolver never gets called from these tests. Exporting a stub keeps the
// import surface honest if anyone re-wires the handler to bypass the mock.
vi.mock("../worker/doh-resolve4", () => ({
  makeResolve4: () => async () => [] as string[],
}));

import { handleRegister } from "../worker/oauth/register";
import { isPrivateUrl } from "../worker/is-private-url";

type FetchMock = ReturnType<typeof vi.fn>;

function makeEnv(): {
  env: Env;
  doFetch: FetchMock;
  getByName: FetchMock;
} {
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

function req(body: unknown, method = "POST"): Request {
  const init: RequestInit = { method };
  // GET/HEAD requests cannot carry a body in the Fetch spec.
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "content-type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://worker.local/oauth/register", init);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 32 random bytes → base64url-no-pad → 43 chars of [A-Za-z0-9_-].
const BASE64URL_RE = /^[A-Za-z0-9_\-]{43}$/;

describe("handleRegister (POST /oauth/register) — RFC 7591 dynamic client registration", () => {
  let env: Env;
  let doFetch: FetchMock;
  let getByName: FetchMock;

  beforeEach(() => {
    ({ env, doFetch, getByName } = makeEnv());
    vi.mocked(isPrivateUrl).mockReset();
    // Default: every URL is public.
    vi.mocked(isPrivateUrl).mockResolvedValue(false);
  });

  it("happy path: 201 with clientId (UUID), clientSecret (base64url), redirectUris, clientName='unnamed'", async () => {
    const res = await handleRegister(
      req({ redirect_uris: ["https://example.com/cb"] }),
      env,
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.clientId).toBe("string");
    expect(body.clientId).toMatch(UUID_RE);

    expect(typeof body.clientSecret).toBe("string");
    expect(body.clientSecret as string).toMatch(BASE64URL_RE);

    expect(body.redirectUris).toEqual(["https://example.com/cb"]);
    expect(body.clientName).toBe("unnamed");
    expect(typeof body.createdAt).toBe("number");

    // DO was called once with the canonical stub URL and the serialized
    // client as JSON body.
    expect(getByName).toHaveBeenCalledTimes(1);
    expect(getByName).toHaveBeenCalledWith(body.clientId);
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] as [
      string,
      RequestInit | undefined,
    ];
    expect(url).toBe("https://stub/register");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      redirectUris: ["https://example.com/cb"],
      clientName: "unnamed",
      createdAt: body.createdAt,
    });

    // isPrivateUrl was consulted for every redirect_uri.
    expect(vi.mocked(isPrivateUrl)).toHaveBeenCalledTimes(1);
  });

  it("preserves a caller-supplied client_name", async () => {
    const res = await handleRegister(
      req({
        redirect_uris: ["https://example.com/cb"],
        client_name: "my agent",
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { clientName: string };
    expect(body.clientName).toBe("my agent");
  });

  it("returns 400 invalid_request when redirect_uris is missing", async () => {
    const res = await handleRegister(req({}), env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    // DO must NOT be touched when validation fails.
    expect(getByName).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_request when redirect_uris is empty", async () => {
    const res = await handleRegister(req({ redirect_uris: [] }), env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(getByName).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_request when redirect_uris is not an array", async () => {
    const res = await handleRegister(
      req({ redirect_uris: "not-an-array" }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(getByName).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_redirect_uri when a redirect_uri is private (localhost)", async () => {
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(true);
    const res = await handleRegister(
      req({ redirect_uris: ["http://localhost/cb"] }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_redirect_uri");
    expect(body.error_description).toContain("http://localhost/cb");
    // Critical: the DO is NEVER reached when validation rejects the URL.
    expect(getByName).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_redirect_uri when a redirect_uri is a private IP literal (10.0.0.1)", async () => {
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(true);
    const res = await handleRegister(
      req({ redirect_uris: ["http://10.0.0.1/cb"] }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
    expect(getByName).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_redirect_uri on the FIRST offending URI (does not leak later URIs)", async () => {
    // Second URI is private; we expect the response to mention it (the loop
    // walks in order and bails on the first hit).
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(false);
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(true);
    const res = await handleRegister(
      req({
        redirect_uris: ["https://ok.example/cb", "http://10.0.0.1/cb"],
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_redirect_uri");
    expect(body.error_description).toContain("http://10.0.0.1/cb");
    expect(getByName).not.toHaveBeenCalled();
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await handleRegister(req({}, "GET"), env);
    expect(res.status).toBe(405);
    // Nothing should reach the DO for a wrong-method request.
    expect(getByName).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });
});
