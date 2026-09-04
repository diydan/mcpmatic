import { describe, expect, it } from "vitest";
import { hashSecret } from "../worker/oauth/secret";
import type {
  AccessToken,
  AuthCode,
  OAuthClient,
  PkceChallenge,
} from "../worker/oauth/types";

describe("OAuth types", () => {
  it("OAuthClient carries id, secret hash, redirect URIs, name, createdAt", async () => {
    const c: OAuthClient = {
      clientId: "client-abc",
      // Salt = clientId per DSRV-L1; the plaintext never lives on the
      // persisted record.
      clientSecretHash: await hashSecret("secret-xyz", "client-abc"),
      redirectUris: ["https://example.com/callback"],
      clientName: "test client",
      createdAt: 1700000000000,
    };
    expect(c.redirectUris).toHaveLength(1);
    expect(c.createdAt).toBeGreaterThan(0);
    expect(c.clientSecretHash.startsWith("sha256:")).toBe(true);
  });

  it("AuthCode binds PKCE challenge + method + expiry + used flag", () => {
    const code: AuthCode = {
      code: "auth-code-1",
      clientId: "client-abc",
      userSessionToken: "a".repeat(64),
      redirectUri: "https://example.com/callback",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      codeChallengeMethod: "S256",
      expiresAt: 1700000600000,
      used: false,
    };
    expect(code.codeChallengeMethod).toBe("S256");
    expect(code.used).toBe(false);
  });

  it("AccessToken + PkceChallenge carry their expected fields", () => {
    const tok: AccessToken = {
      token: "access-token-1",
      clientId: "client-abc",
      userSessionToken: "a".repeat(64),
      scope: "mcp:tools",
      expiresAt: 1700003600000,
      refreshToken: "refresh-token-1",
    };
    expect(tok.scope).toBe("mcp:tools");
    const pkce: PkceChallenge = {
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      codeChallengeMethod: "S256",
    };
    expect(pkce.codeChallengeMethod).toBe("S256");
  });
});
