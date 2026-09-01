/**
 * Storage interface for OAuth entities.
 *
 * Clients and auth codes are stored in Durable Objects (one per client, one
 * per code) so single-use / atomic semantics are natural. Access and refresh
 * tokens live in KV with TTLs so they expire automatically.
 *
 * Downstream tasks build the concrete implementations:
 *   - Task 3: OAuthClientDO backs getClient / putClient / revokeClient
 *   - Task 4: OAuthCodeDO backs issueCode / consumeCode
 *   - Task 7: KV-backed token store backs the access/refresh token methods
 */
import type { AccessToken, AuthCode, OAuthClient } from "./types";

export interface OAuthStore {
  // Client storage (DO-backed, one DO per clientId).
  getClient(clientId: string): Promise<OAuthClient | null>;
  putClient(client: OAuthClient): Promise<void>;
  revokeClient(clientId: string): Promise<void>;

  // Auth code storage (DO-backed, one DO per code; single-use atomic consume).
  issueCode(code: AuthCode): Promise<void>;
  consumeCode(code: string): Promise<AuthCode | null>;

  // Access + refresh token storage (KV-backed with TTLs).
  putAccessToken(token: AccessToken, ttlSeconds: number): Promise<void>;
  getAccessToken(token: string): Promise<AccessToken | null>;
  putRefreshToken(token: AccessToken, ttlSeconds: number): Promise<void>;
  getRefreshToken(refreshToken: string): Promise<AccessToken | null>;
  deleteRefreshToken(refreshToken: string): Promise<void>;
}
