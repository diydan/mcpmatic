import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression coverage for the clientSecret-at-rest hardening (audit #1.2
 * + #1.3 in task-1-report.md). Before the fix:
 *   - register.ts stored `clientSecret: <plaintext>` directly in the DO.
 *   - token.ts compared it with `client.clientSecret !== clientSecret`,
 *     a plain string compare vulnerable to timing analysis.
 *
 * After the fix:
 *   - registration computes a salted SHA-256 digest of the plaintext and
 *     stores `{ clientSecretHash, clientSecretSalt }` — plaintext is NEVER
 *     written to durable storage.
 *   - the registration RESPONSE echoes the plaintext (per RFC 7591 §3.2.1
 *     for confidential clients) so the caller can use it immediately.
 *   - token.ts hashes the presented plaintext with the stored salt and
 *     compares the digests in constant time.
 */

vi.mock("../worker/is-private-url", () => ({
  isPrivateUrl: vi.fn().mockResolvedValue(false),
}));
vi.mock("../worker/doh-resolve4", () => ({
  makeResolve4: () => async () => [] as string[],
}));

import { handleRegister } from "../worker/oauth/register";
import { handleToken } from "../worker/oauth/token";
import type { OAuthClient } from "../worker/oauth/types";

type FetchMock = ReturnType<typeof vi.fn>;

interface RegisterShim {
  env: Env;
  doFetch: FetchMock;
  getByName: FetchMock;
}

function makeRegisterEnv(): RegisterShim {
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

function registerReq(body: unknown): Request {
  return new Request("https://worker.local/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const HEX64 = /^[0-9a-f]{64}$/;
// 16 random bytes → base64url-no-pad → 22 chars.
const BASE64URL_SALT = /^[A-Za-z0-9_\-]{22}$/;

describe("handleRegister — clientSecret hashing at rest", () => {
  let shim: RegisterShim;

  beforeEach(() => {
    shim = makeRegisterEnv();
  });

  it("stores a salted SHA-256 hash, not the plaintext", async () => {
    const res = await handleRegister(
      registerReq({ redirect_uris: ["https://example.com/cb"] }),
      shim.env,
    );
    expect(res.status).toBe(201);

    const [, init] = shim.doFetch.mock.calls[0] as [
      string,
      RequestInit | undefined,
    ];
    const persisted = JSON.parse(init!.body as string) as Record<
      string,
      unknown
    >;

    // Plaintext must NEVER be persisted.
    expect(persisted).not.toHaveProperty("clientSecret");

    // Hash + salt ARE persisted, both well-formed.
    expect(typeof persisted.clientSecretHash).toBe("string");
    expect(persisted.clientSecretHash).toMatch(HEX64);
    expect(typeof persisted.clientSecretSalt).toBe("string");
    expect(persisted.clientSecretSalt).toMatch(BASE64URL_SALT);
  });

  it("echoes the plaintext clientSecret in the registration response (RFC 7591 §3.2.1)", async () => {
    const res = await handleRegister(
      registerReq({ redirect_uris: ["https://example.com/cb"] }),
      shim.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // The caller needs the plaintext to authenticate — we MUST return it
    // exactly once, on registration.
    expect(typeof body.clientSecret).toBe("string");
    expect(body.clientSecret as string).toMatch(
      /^[A-Za-z0-9_\-]{43}$/,
    );
  });

  it("the echoed plaintext is the secret the hash was derived from", async () => {
    // Round-trip: register, then recompute hash from response plaintext +
    // persisted salt and assert it matches the persisted hash.
    const res = await handleRegister(
      registerReq({ redirect_uris: ["https://example.com/cb"] }),
      shim.env,
    );
    const body = (await res.json()) as Record<string, unknown>;
    const [, init] = shim.doFetch.mock.calls[0] as [
      string,
      RequestInit | undefined,
    ];
    const persisted = JSON.parse(init!.body as string) as Record<
      string,
      unknown
    >;

    // Recompute the hash in the test (mirrors the implementation).
    const data = new TextEncoder().encode(
      `${body.clientSecret}|${persisted.clientSecretSalt}`,
    );
    const digest = await crypto.subtle.digest("SHA-256", data);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(persisted.clientSecretHash);
  });

  it("every registration generates a fresh salt (no salt reuse across clients)", async () => {
    const r1 = await handleRegister(
      registerReq({ redirect_uris: ["https://a.example/cb"] }),
      shim.env,
    );
    const r2 = await handleRegister(
      registerReq({ redirect_uris: ["https://b.example/cb"] }),
      shim.env,
    );
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const s1 = JSON.parse(
      (shim.doFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ).clientSecretSalt;
    const s2 = JSON.parse(
      (shim.doFetch.mock.calls[1] as [string, RequestInit])[1].body as string,
    ).clientSecretSalt;
    expect(s1).not.toBe(s2);
  });
});

// -----------------------------------------------------------------------
// token.ts — constant-time hash compare replaces plain string compare
// -----------------------------------------------------------------------

interface TokenShim {
  env: Env;
  clientFetch: FetchMock;
  clientGetByName: FetchMock;
  codeGetByName: FetchMock;
  codeFetch: FetchMock;
  kv: {
    store: Map<string, string>;
    get: FetchMock;
    put: FetchMock;
    delete: FetchMock;
  };
  lastClientIdRef: { current: string | undefined };
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeTokenShimWithStoredSecret(
  plaintext: string,
): Promise<TokenShim> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = btoa(String.fromCharCode(...saltBytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const hash = await sha256Hex(`${plaintext}|${salt}`);

  const stored: OAuthClient = {
    clientId: "client-abc",
    clientSecretHash: hash,
    clientSecretSalt: salt,
    redirectUris: ["https://example.com/cb"],
    clientName: "test client",
    createdAt: 1700000000000,
  };

  const lastClientIdRef: { current: string | undefined } = { current: undefined };

  const clientFetch = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.pathname === "/get") {
        const id = lastClientIdRef.current ?? "";
        return id === stored.clientId
          ? Response.json(stored)
          : new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });
  const clientGetByName = vi
    .fn<(name: string) => { fetch: FetchMock }>()
    .mockImplementation((name: string) => {
      lastClientIdRef.current = name;
      return { fetch: clientFetch };
    });

  const codeFetch = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValue(new Response("invalid_grant", { status: 400 }));
  const codeGetByName = vi
    .fn<(name: string) => { fetch: FetchMock }>()
    .mockReturnValue({ fetch: codeFetch });

  const store = new Map<string, string>();
  const kv = {
    store,
    get: vi.fn<(k: string) => Promise<string | null>>().mockImplementation(async (k) =>
      store.has(k) ? store.get(k)! : null,
    ),
    put: vi.fn().mockImplementation(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn().mockImplementation(async (k: string) => {
      store.delete(k);
    }),
  };

  const env = {
    OAUTH_CLIENT: { getByName: clientGetByName },
    OAUTH_CODE: { getByName: codeGetByName },
    OAUTH_TOKENS: kv,
  } as unknown as Env;

  return {
    env,
    clientFetch,
    clientGetByName,
    codeGetByName,
    codeFetch,
    kv,
    lastClientIdRef,
  };
}

function tokenReq(params: Record<string, string>): Request {
  return new Request("https://worker.local/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

describe("handleToken — authenticates via salted SHA-256 hash comparison", () => {
  let pkceMock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const pkce = await import("../worker/oauth/pkce");
    pkceMock = vi.spyOn(pkce, "verifyPkce").mockResolvedValue(true);
  });

  it("succeeds when the presented plaintext matches the stored hash", async () => {
    const plaintext = "correct-secret-value";
    const shim = await makeTokenShimWithStoredSecret(plaintext);

    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: "auth-code-xyz",
        redirect_uri: "https://example.com/cb",
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        client_id: "client-abc",
        client_secret: plaintext,
      }),
      shim.env,
    );

    // Authenticated — we get past the gate (200 or 400 invalid_grant,
    // depending on the code-consume stub, but NEVER 401 invalid_client).
    expect(res.status).not.toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe("invalid_client");
  });

  it("fails with 401 invalid_client when the presented plaintext is wrong", async () => {
    const shim = await makeTokenShimWithStoredSecret("correct-secret-value");

    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: "auth-code-xyz",
        redirect_uri: "https://example.com/cb",
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        client_id: "client-abc",
        client_secret: "wrong-secret-value",
      }),
      shim.env,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");

    // Code DO never reached, KV never touched.
    expect(shim.codeGetByName).not.toHaveBeenCalled();
    expect(shim.kv.put).not.toHaveBeenCalled();
  });

  it("fails when the stored record is missing the hash/salt fields (defensive)", async () => {
    // Simulate a legacy / corrupted record that lacks the hash fields.
    const legacy: Record<string, unknown> = {
      clientId: "client-abc",
      redirectUris: ["https://example.com/cb"],
      clientName: "legacy",
      createdAt: 1700000000000,
    };

    const lastClientIdRef: { current: string | undefined } = { current: undefined };
    const clientFetch = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockImplementation(async (input) => {
        const url = new URL(typeof input === "string" ? input : (input as Request).url);
        if (url.pathname === "/get") {
          return Response.json(legacy);
        }
        return new Response("not found", { status: 404 });
      });
    const clientGetByName = vi
      .fn<(name: string) => { fetch: FetchMock }>()
      .mockImplementation((name: string) => {
        lastClientIdRef.current = name;
        return { fetch: clientFetch as FetchMock };
      });
    const codeGetByName = vi
      .fn<() => { fetch: FetchMock }>()
      .mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
      });
    const env = {
      OAUTH_CLIENT: { getByName: clientGetByName },
      OAUTH_CODE: { getByName: codeGetByName },
      OAUTH_TOKENS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        store: new Map<string, string>(),
      },
    } as unknown as Env;

    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: "auth-code-xyz",
        redirect_uri: "https://example.com/cb",
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        client_id: "client-abc",
        client_secret: "any-secret",
      }),
      env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });
});
