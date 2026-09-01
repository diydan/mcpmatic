import { describe, expect, it, vi } from "vitest";
import { authenticate, extractBearer } from "../worker/mcp/auth";
import type { AccessToken } from "../worker/oauth/types";

/**
 * Bearer-token auth at /mcp. The shape validation that used to live in
 * `isValidToken` is now inside `resolveMcpToken` — these tests cover the
 * integration at the request boundary instead.
 */

const SESSION_TOKEN = "a".repeat(64);
const BASE64URL_TOKEN = "A".repeat(43);

function makeEnv(stored: AccessToken | null = null): Env {
  const get = vi
    .fn<(key: string) => Promise<string | null>>()
    .mockImplementation(async (key: string) =>
      key === `token:${BASE64URL_TOKEN}` && stored
        ? JSON.stringify(stored)
        : null,
    );
  return { OAUTH_TOKENS: { get } } as unknown as Env;
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

describe("MCP bearer auth", () => {
  it("extracts a valid Bearer token", () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: "Bearer abc123" },
    });
    expect(extractBearer(req)).toBe("abc123");
  });

  it("returns null on missing Authorization header", () => {
    const req = new Request("https://example.com/mcp");
    expect(extractBearer(req)).toBeNull();
  });

  it("returns null on non-Bearer scheme", () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(extractBearer(req)).toBeNull();
  });

  it("authenticates a 64-hex session token", async () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });
    const result = await authenticate(req, makeEnv());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe(SESSION_TOKEN);
  });

  it("authenticates an OAuth access token by resolving it to the session token", async () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: `Bearer ${BASE64URL_TOKEN}` },
    });
    const result = await authenticate(req, makeEnv(accessToken()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe(SESSION_TOKEN);
  });

  it("rejects a malformed token with 401", async () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: "Bearer tooshort" },
    });
    const result = await authenticate(req, makeEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects a 64-char non-hex token with 401", async () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: `Bearer ${"z".repeat(64)}` },
    });
    const result = await authenticate(req, makeEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects a 65-char token with 401", async () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: `Bearer ${"a".repeat(65)}` },
    });
    const result = await authenticate(req, makeEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});
