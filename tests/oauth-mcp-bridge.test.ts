import { describe, expect, it, vi } from "vitest";
import { authenticate } from "../worker/mcp/auth";
import { resolveMcpToken } from "../worker/oauth/mcp-bridge";
import type { AccessToken } from "../worker/oauth/types";

/**
 * Tests for the /mcp auth bridge.
 *
 * `resolveMcpToken` is a pure function over (token, env) — its env
 * dependency is just `OAUTH_TOKENS.get`. Tests build a minimal env shim
 * with a vi.fn-mocked KV so we can assert what was looked up and what
 * came back.
 *
 * The downstream `authenticate(request, env)` test exercises the same
 * plumbing through the HTTP layer — extracting the Bearer, resolving it,
 * and returning a usable session token.
 */

const SESSION_TOKEN = "a".repeat(64);
const BASE64URL_TOKEN = "A".repeat(43); // 43 chars, all valid base64url.

interface KvShim {
  store: Map<string, string>;
  get: ReturnType<typeof vi.fn>;
}

function makeEnv(initial: Record<string, string> = {}): { env: Env; kv: KvShim } {
  const store = new Map<string, string>(Object.entries(initial));
  const get = vi
    .fn<(key: string) => Promise<string | null>>()
    .mockImplementation(async (key: string) =>
      store.has(key) ? store.get(key)! : null,
    );
  const env = { OAUTH_TOKENS: { get } } as unknown as Env;
  return { env, kv: { store, get } };
}

function accessToken(overrides: Partial<AccessToken> = {}): AccessToken {
  return {
    token: BASE64URL_TOKEN,
    clientId: "client-abc",
    userSessionToken: SESSION_TOKEN,
    scope: "mcp:tools",
    expiresAt: Date.now() + 60 * 1000,
    refreshToken: "r".repeat(43),
    ...overrides,
  };
}

describe("resolveMcpToken — session token pass-through", () => {
  it("returns a 64-hex token verbatim and does NOT call KV", async () => {
    const { env, kv } = makeEnv();
    const out = await resolveMcpToken("a".repeat(64), env);
    expect(out).toBe("a".repeat(64));
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("accepts mixed-case hex (regex is case-insensitive)", async () => {
    const { env, kv } = makeEnv();
    const tok = "A".repeat(64);
    const out = await resolveMcpToken(tok, env);
    expect(out).toBe(tok);
    expect(kv.get).not.toHaveBeenCalled();
  });
});

describe("resolveMcpToken — OAuth access token resolution", () => {
  it("looks up `token:<bearer>` and returns the userSessionToken", async () => {
    const stored = accessToken();
    const { env, kv } = makeEnv({
      [`token:${BASE64URL_TOKEN}`]: JSON.stringify(stored),
    });

    const out = await resolveMcpToken(BASE64URL_TOKEN, env);
    expect(out).toBe(SESSION_TOKEN);
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.get).toHaveBeenCalledWith(`token:${BASE64URL_TOKEN}`);
  });

  it("returns null when KV has no entry for this bearer", async () => {
    const { env, kv } = makeEnv();
    const out = await resolveMcpToken(BASE64URL_TOKEN, env);
    expect(out).toBeNull();
    expect(kv.get).toHaveBeenCalledWith(`token:${BASE64URL_TOKEN}`);
  });

  it("returns null when expiresAt is in the past (second-line defense)", async () => {
    const stored = accessToken({ expiresAt: Date.now() - 1 });
    const { env } = makeEnv({
      [`token:${BASE64URL_TOKEN}`]: JSON.stringify(stored),
    });

    const out = await resolveMcpToken(BASE64URL_TOKEN, env);
    expect(out).toBeNull();
  });

  it("returns null when expiresAt equals Date.now() (boundary)", async () => {
    const now = Date.now();
    const stored = accessToken({ expiresAt: now });
    const { env } = makeEnv({
      [`token:${BASE64URL_TOKEN}`]: JSON.stringify(stored),
    });

    const viNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const out = await resolveMcpToken(BASE64URL_TOKEN, env);
      expect(out).toBeNull();
    } finally {
      viNow.mockRestore();
    }
  });

  it("returns null when KV returns malformed JSON (does not throw)", async () => {
    const { env } = makeEnv({
      [`token:${BASE64URL_TOKEN}`]: "this-is-not-json{{{",
    });

    const out = await resolveMcpToken(BASE64URL_TOKEN, env);
    expect(out).toBeNull();
  });

  it("returns null when the parsed payload has no userSessionToken", async () => {
    const { env } = makeEnv({
      [`token:${BASE64URL_TOKEN}`]: JSON.stringify({
        token: BASE64URL_TOKEN,
        clientId: "client-abc",
        scope: "mcp:tools",
        expiresAt: Date.now() + 60_000,
        refreshToken: "r".repeat(43),
        // userSessionToken intentionally missing
      }),
    });

    const out = await resolveMcpToken(BASE64URL_TOKEN, env);
    expect(out).toBeNull();
  });

  it("returns null when expiresAt is not a number", async () => {
    const { env } = makeEnv({
      [`token:${BASE64URL_TOKEN}`]: JSON.stringify({
        ...accessToken(),
        expiresAt: "not-a-number",
      }),
    });

    const out = await resolveMcpToken(BASE64URL_TOKEN, env);
    expect(out).toBeNull();
  });
});

describe("resolveMcpToken — malformed inputs", () => {
  it("returns null for an empty string", async () => {
    const { env, kv } = makeEnv();
    expect(await resolveMcpToken("", env)).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("returns null for a short non-conforming token", async () => {
    const { env, kv } = makeEnv();
    expect(await resolveMcpToken("abc", env)).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("returns null for a 43-char token that is not base64url", async () => {
    // '!' is not in the base64url alphabet.
    const { env, kv } = makeEnv();
    expect(await resolveMcpToken("!".repeat(43), env)).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("returns null for a 64-char non-hex token", async () => {
    const { env, kv } = makeEnv();
    expect(await resolveMcpToken("z".repeat(64), env)).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("returns null for a 65-char hex token (one over)", async () => {
    const { env, kv } = makeEnv();
    expect(await resolveMcpToken("a".repeat(65), env)).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
  });
});

describe("authenticate(request, env) — bridge integration", () => {
  it("returns the resolved session token when an OAuth access token is presented", async () => {
    const stored = accessToken();
    const { env } = makeEnv({
      [`token:${BASE64URL_TOKEN}`]: JSON.stringify(stored),
    });

    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: `Bearer ${BASE64URL_TOKEN}` },
    });

    const result = await authenticate(req, env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe(SESSION_TOKEN);
  });

  it("returns the same session token verbatim when a session token is presented", async () => {
    const { env, kv } = makeEnv();
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    const result = await authenticate(req, env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe(SESSION_TOKEN);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("returns a 401 with WWW-Authenticate when the bearer is malformed", async () => {
    const { env } = makeEnv();
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });

    const result = await authenticate(req, env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("WWW-Authenticate")).toContain("Bearer");
    }
  });

  it("returns a 401 when the Authorization header is missing", async () => {
    const { env } = makeEnv();
    const req = new Request("https://example.com/mcp");

    const result = await authenticate(req, env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns a 401 when an OAuth token is presented but KV has no record", async () => {
    const { env } = makeEnv();
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: `Bearer ${BASE64URL_TOKEN}` },
    });

    const result = await authenticate(req, env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns a 401 when the stored OAuth token has expired", async () => {
    const stored = accessToken({ expiresAt: Date.now() - 1 });
    const { env } = makeEnv({
      [`token:${BASE64URL_TOKEN}`]: JSON.stringify(stored),
    });

    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: `Bearer ${BASE64URL_TOKEN}` },
    });

    const result = await authenticate(req, env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});
