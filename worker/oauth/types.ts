export type OAuthClient = {
  clientId: string;
  /**
   * Salted SHA-256 digest of the plaintext clientSecret, hex-encoded.
   * Plaintext is never persisted; it is echoed back to the caller once
   * at /oauth/register and not stored on the server. See `secret.ts`.
   */
  clientSecretHash: string;
  /** Per-client random salt, base64url-no-pad. */
  clientSecretSalt: string;
  redirectUris: string[];
  clientName: string;
  createdAt: number;
};

/**
 * Response shape for POST /oauth/register. The plaintext `clientSecret`
 * is included exactly once (RFC 7591 §3.2.1) so the caller can
 * authenticate at /oauth/token; the storage shape (`OAuthClient`) has
 * only the hash + salt.
 */
export type OAuthClientRegistration = {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName: string;
  createdAt: number;
};

export type AuthCode = {
  code: string;
  clientId: string;
  userSessionToken: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: number;
  used: boolean;
};

export type AccessToken = {
  token: string;
  clientId: string;
  userSessionToken: string;
  scope: string;
  expiresAt: number;
  refreshToken: string;
};

export type PkceChallenge = {
  codeChallenge: string;
  codeChallengeMethod: "S256";
};
