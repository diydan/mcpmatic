/**
 * Tests for the optional `{ origin: string }` body on POST /sessions.
 *
 * Background: existing callers (notably src/pages/Home.tsx) POST to
 * /sessions with no body and expect `{ sessionToken, url }`. We now accept
 * an optional JSON body `{ origin?: string }` so the user can initialize a
 * session against any site (not just the demo origins in shared/stores.ts)
 * and skip the first round-trip to /s/<token>/consent.
 *
 * The handler runs validation in the worker (NOT in the DO): URL.parse,
 * `https:` protocol, and `isPrivateUrl(...) === false`. On failure it
 * returns 400 with `{ error: "invalid origin" }` (or `{ error: "invalid
 * body" }` for parse failures). On success it forwards the origin to
 * `stub.initSession(token, origin)` so the SessionDO can persist it in the
 * same SQL transaction as the sentinel meta row.
 *
 * The SSRF guard itself (`isPrivateUrl`) is fully covered by
 * tests/ssrf.test.ts. Here we mock it so the test stays deterministic and
 * exercises just the worker's validation + dispatch logic — same pattern
 * as tests/oauth-register.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the SSRF guard. The default for the happy paths is "URL is public".
// Per-test overrides flip the resolution to "URL is private" so the
// handler rejects the corresponding body shape with 400.
vi.mock("../worker/is-private-url", () => ({
  isPrivateUrl: vi.fn(),
}));

// Same idea for the resolver factory — `isPrivateUrl` is mocked, so the
// resolver never gets called from these tests. Exporting a stub keeps the
// import surface honest if anyone re-wires the handler to bypass the mock.
vi.mock("../worker/doh-resolve4", () => ({
  makeResolve4: () => async () => [] as string[],
}));

// The SessionDO pulls in `cloudflare:workers` (which the Node test env
// can't resolve), so stub it at the source. The stub captures every
// `initSession` call so the test can assert the origin was forwarded.
vi.mock("../worker/session-do", () => ({
  SessionDO: class SessionDO {
    static __initSession = vi.fn();
    initSession(token: string, origin?: string) {
      SessionDO.__initSession(token, origin);
      return Promise.resolve();
    }
  },
}));
vi.mock("../worker/account-do", () => ({ AccountDO: class AccountDO {} }));

// Pull the mocked handles AFTER the mocks are registered.
import { isPrivateUrl } from "../worker/is-private-url";
import { SessionDO } from "../worker/session-do";
import worker from "../worker/index";

// ------------------------------------------------------------------------

interface EnvShim {
  env: Env;
  initSession: ReturnType<typeof vi.fn>;
}

function makeEnv(): EnvShim {
  const initSession = (SessionDO as unknown as {
    __initSession: ReturnType<typeof vi.fn>;
  }).__initSession;
  const env = {
    // The /sessions route only consults SESSION.getByName. Other DOs are
    // never reached by these tests, but the worker type expects them.
    SESSION: {
      getByName: vi.fn((_name: string) => new SessionDO()),
    },
    OAUTH_CLIENT: { getByName: vi.fn() },
    OAUTH_CODE: { getByName: vi.fn() },
  } as unknown as Env;
  return { env, initSession };
}

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

beforeEach(() => {
  (SessionDO as unknown as {
    __initSession: ReturnType<typeof vi.fn>;
  }).__initSession.mockReset();
  vi.mocked(isPrivateUrl).mockReset();
  vi.mocked(isPrivateUrl).mockResolvedValue(false);
});

// ------------------------------------------------------------------------

describe("POST /sessions — back-compat (no body)", () => {
  it("empty body (no Content-Type) → 200 with { sessionToken, url } and initSession(token) called without origin", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", { method: "POST" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string; url: string };
    expect(body.sessionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(body.url).toBe(`https://worker.local/s/${body.sessionToken}`);
    // Back-compat: a no-body POST must NOT pass an origin. Old clients
    // (Home.tsx today) rely on this — no consent gets seeded.
    expect(initSession).toHaveBeenCalledTimes(1);
    expect(initSession).toHaveBeenCalledWith(body.sessionToken, undefined);
  });

  it("returns the console url alongside the façade url", async () => {
    // `url` is what an agent loads. A human needs /c/<token>: it is the only
    // view that can answer an approval.
    const { env } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", { method: "POST" }),
      env,
    );
    const body = (await res.json()) as {
      sessionToken: string;
      url: string;
      consoleUrl: string;
    };
    expect(body.url).toBe(`https://worker.local/s/${body.sessionToken}`);
    expect(body.consoleUrl).toBe(`https://worker.local/c/${body.sessionToken}`);
  });

  it("application/json body with empty object {} → 200, initSession(token) without origin", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string };
    expect(initSession).toHaveBeenCalledWith(body.sessionToken, undefined);
  });

  it("application/json body with { origin: \"\" } → 200 (empty string treated as absent)", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string };
    expect(initSession).toHaveBeenCalledWith(body.sessionToken, undefined);
  });
});

// ------------------------------------------------------------------------

describe("POST /sessions — origin seed (happy path)", () => {
  it("valid https origin → 200; initSession(token, origin) called with the origin", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "https://example.com" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionToken: string;
      url: string;
      origin: string | null;
    };
    expect(body.sessionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(body.url).toBe(`https://worker.local/s/${body.sessionToken}`);
    expect(body.origin).toBe("https://example.com");
    // Origin was forwarded to the DO so the seed-consent path runs.
    expect(initSession).toHaveBeenCalledTimes(1);
    expect(initSession).toHaveBeenCalledWith(
      body.sessionToken,
      "https://example.com",
    );
    // isPrivateUrl was consulted exactly once for the parsed origin.
    expect(vi.mocked(isPrivateUrl)).toHaveBeenCalledTimes(1);
  });

  it("valid https origin with path/query is normalized to origin only (path/query stripped)", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "https://example.com/some/path?q=1" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Path/query stripped: seeded consent matches the bare origin so
    // subsequent tool calls (e.g. navigate_to with origin="https://example.com")
    // match without needing a re-grant.
    expect(initSession).toHaveBeenCalledWith(
      expect.any(String),
      "https://example.com",
    );
  });

  it("bare host (no protocol) auto-prepends https://", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "example.com" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(initSession).toHaveBeenCalledWith(
      expect.any(String),
      "https://example.com",
    );
  });

  it("bare host with www. auto-prepends https:// (www preserved)", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "www.example.com" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // www. is preserved — it's part of the hostname, distinct from
    // the bare origin in URL semantics.
    expect(initSession).toHaveBeenCalledWith(
      expect.any(String),
      "https://www.example.com",
    );
  });

  it("bare host with path auto-prepends https:// and strips path", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "example.com/products/x" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(initSession).toHaveBeenCalledWith(
      expect.any(String),
      "https://example.com",
    );
  });
});

// ------------------------------------------------------------------------

describe("POST /sessions — origin validation failures", () => {
  it("http:// origin (non-https) → 400 invalid origin; initSession NOT called", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "http://example.com" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid origin");
    expect(initSession).not.toHaveBeenCalled();
    // isPrivateUrl is NOT consulted: the protocol guard already rejected.
    expect(vi.mocked(isPrivateUrl)).not.toHaveBeenCalled();
  });

  it("origin that fails URL.parse AND fails auto-prepend parse → 400 invalid origin", async () => {
    const { env, initSession } = makeEnv();
    // "not-a-url" → new URL("not-a-url") throws → tries
    // new URL("https://not-a-url") → succeeds syntactically → SSRF guard
    // would normally reject via DNS NXDOMAIN. Mock the SSRF guard to
    // simulate that rejection here so the test stays deterministic.
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(true);
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "not-a-url" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid origin");
    expect(initSession).not.toHaveBeenCalled();
    expect(vi.mocked(isPrivateUrl)).toHaveBeenCalledTimes(1);
  });

  it("origin that is a non-https scheme (file:) → 400 invalid origin", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "file:///etc/passwd" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(initSession).not.toHaveBeenCalled();
  });

  it("loopback IP (https://127.0.0.1) → 400 (isPrivateUrl returns true)", async () => {
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(true);
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "https://127.0.0.1" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid origin");
    expect(initSession).not.toHaveBeenCalled();
    expect(vi.mocked(isPrivateUrl)).toHaveBeenCalledTimes(1);
  });

  it("RFC 1918 private IP (https://192.168.1.1) → 400", async () => {
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(true);
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "https://192.168.1.1" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(initSession).not.toHaveBeenCalled();
  });

  it("link-local / cloud metadata (https://169.254.169.254) → 400", async () => {
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(true);
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "https://169.254.169.254" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(initSession).not.toHaveBeenCalled();
  });

  it("IPv6 loopback (https://[::1]) → 400", async () => {
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(true);
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "https://[::1]" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(initSession).not.toHaveBeenCalled();
  });

  it("non-string origin (number) → 400 invalid origin", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: 123 }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid origin");
    expect(initSession).not.toHaveBeenCalled();
  });

  it("non-string origin (object) → 400 invalid origin", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: { nested: "value" } }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(initSession).not.toHaveBeenCalled();
  });

  it("non-string origin (boolean) → 400 invalid origin", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: true }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(initSession).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------

describe("POST /sessions — invalid JSON body", () => {
  it("application/json with malformed JSON → 400 invalid body; initSession NOT called", async () => {
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid body");
    expect(initSession).not.toHaveBeenCalled();
  });

  it("non-JSON Content-Type (text/plain) → treated as no body; back-compat", async () => {
    // Back-compat: callers that send a text body without setting
    // application/json are treated as no body, NOT as invalid JSON. This
    // matches the existing behavior (Home.tsx today) where Content-Type
    // is unset and the request works fine.
    const { env, initSession } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "anything goes",
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(initSession).toHaveBeenCalledTimes(1);
    expect(initSession).toHaveBeenCalledWith(expect.any(String), undefined);
  });
});

// ------------------------------------------------------------------------

describe("POST /sessions — error response shape", () => {
  it("400 responses do NOT carry the OAuth-only Cache-Control: no-store header", async () => {
    // Use an input that the SSRF guard rejects — "https://127.0.0.1"
    // is a private IP literal, so isPrivateUrl returns true. After
    // lenient parsing this is a clean rejection.
    vi.mocked(isPrivateUrl).mockResolvedValueOnce(true);
    const { env } = makeEnv();
    const res = await worker.fetch!(
      req("https://worker.local/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: "https://127.0.0.1" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    // /sessions is not an OAuth endpoint; the OAuth-only Cache-Control
    // guard does not apply here. The response body is `{ error }` only.
    expect(res.headers.get("cache-control")).toBeNull();
    const body = (await res.json()) as { error: string };
    expect(Object.keys(body).sort()).toEqual(["error"]);
  });
});