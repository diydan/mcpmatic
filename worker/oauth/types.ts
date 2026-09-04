export type OAuthClient = {
  clientId: string;
  /** Salted SHA-256 of the plaintext `client_secret`, formatted `sha256:<hex>`. */
  clientSecretHash: string;
  redirectUris: string[];
  clientName: string;
  createdAt: number;
};

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
