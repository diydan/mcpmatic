import { DurableObject } from "cloudflare:workers";
import { unionOrigins } from "../shared/origin";
import { AUDIT_DDL, type AuditRow } from "../shared/protocol";
import { toAuditRows, type StoredAuditRow } from "./audit-rows";
import type { StoredCredential } from "./passkey";

/**
 * The durable half of a session.
 *
 * Holds granted origins and the sessions that have claimed this account.
 * Deliberately holds no profile and no field value: the profile lives in the
 * console's localStorage, and moving it here is a separate, opt-in decision
 * (see the session-as-account spec, §Opt-in server-side profile). An account
 * that cannot hold a value cannot leak one.
 */
export class AccountDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS grants (
           origin TEXT PRIMARY KEY,
           granted_at INTEGER NOT NULL
         )`,
      );
      // Same DDL as the session's, deliberately: {origin, tool, field_names,
      // ts}, no value column, ever. The durable copy of a log that must not be
      // able to hold a value is still a log that cannot hold one.
      this.ctx.storage.sql.exec(AUDIT_DDL);
      // A passkey binds this account to an authenticator, so it survives
      // cleared storage and reaches a second device. Public keys only — a
      // passkey's private half never leaves the user's device, which is why
      // this table is not a secret store.
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS credentials (
           id TEXT PRIMARY KEY,
           public_key TEXT NOT NULL,
           counter INTEGER NOT NULL,
           transports TEXT,
           created_at INTEGER NOT NULL
         )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS sessions (
           token TEXT PRIMARY KEY,
           claimed_at INTEGER NOT NULL
         )`,
      );
    });
  }

  async listGrants(): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ origin: string }>(`SELECT origin FROM grants ORDER BY granted_at`)
      .toArray()
      .map((r) => r.origin);
  }

  /** Idempotent: re-granting an origin keeps its original timestamp. */
  async grant(origin: string): Promise<{ ok: true }> {
    if (!origin) return { ok: true };
    this.ctx.storage.sql.exec(
      `INSERT INTO grants (origin, granted_at) VALUES (?, ?)
       ON CONFLICT(origin) DO NOTHING`,
      origin,
      Date.now(),
    );
    return { ok: true };
  }

  async revoke(origin: string): Promise<{ ok: true }> {
    this.ctx.storage.sql.exec(`DELETE FROM grants WHERE origin = ?`, origin);
    return { ok: true };
  }

  /**
   * Record the claim and hand back the union of what the account already had
   * and what the session brought with it.
   *
   * A session granted an origin before being claimed should not lose it, and
   * the account should learn it — the human granted it either way.
   */
  async claim(
    sessionToken: string,
    sessionGrants: readonly string[],
  ): Promise<{ grants: string[] }> {
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (token, claimed_at) VALUES (?, ?)
       ON CONFLICT(token) DO NOTHING`,
      sessionToken,
      Date.now(),
    );
    const merged = unionOrigins(await this.listGrants(), sessionGrants);
    for (const origin of merged) await this.grant(origin);
    return { grants: merged };
  }

  /**
   * The durable copy. The session keeps its own rows as the live view it
   * broadcasts; this is the one that survives the session's two-hour TTL,
   * which is what per-origin telemetry needs to exist at all.
   */
  async recordAudit(
    origin: string,
    tool: string,
    fieldNames: string[],
    ts: number,
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO audit (origin, tool, field_names, ts) VALUES (?, ?, ?, ?)`,
      origin,
      tool,
      JSON.stringify(fieldNames),
      ts,
    );
  }

  async listAudit(limit = 200): Promise<AuditRow[]> {
    return toAuditRows(
      this.ctx.storage.sql
        .exec<StoredAuditRow>(
          `SELECT origin, tool, field_names, ts FROM audit ORDER BY ts DESC LIMIT ?`,
          limit,
        )
        .toArray(),
    );
  }

  async addCredential(c: StoredCredential): Promise<{ ok: true }> {
    this.ctx.storage.sql.exec(
      `INSERT INTO credentials (id, public_key, counter, transports, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET counter = excluded.counter`,
      c.id,
      c.publicKey,
      c.counter,
      c.transports ? JSON.stringify(c.transports) : null,
      Date.now(),
    );
    return { ok: true };
  }

  async getCredential(id: string): Promise<StoredCredential | null> {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        public_key: string;
        counter: number;
        transports: string | null;
      }>(
        `SELECT id, public_key, counter, transports FROM credentials WHERE id = ? LIMIT 1`,
        id,
      )
      .toArray()[0];
    if (!row) return null;
    let transports: string[] | undefined;
    if (row.transports) {
      try {
        const parsed = JSON.parse(row.transports) as unknown;
        if (Array.isArray(parsed)) {
          transports = parsed.filter((x): x is string => typeof x === "string");
        }
      } catch {
        /* a row with unreadable transports is still a usable credential */
      }
    }
    return {
      id: row.id,
      publicKey: row.public_key,
      counter: row.counter,
      transports,
    };
  }

  /**
   * The signature counter is replay protection: an authenticator that reports
   * a counter no higher than the last one may be a clone. Only ever moves up.
   */
  async setCredentialCounter(id: string, counter: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE credentials SET counter = ? WHERE id = ? AND counter < ?`,
      counter,
      id,
      counter,
    );
  }

  async hasCredentials(): Promise<boolean> {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM credentials`)
        .toArray()[0]?.n ?? 0
    ) > 0;
  }

  /**
   * The descriptors a step-up ceremony advertises as `allowCredentials`.
   *
   * `allowCredentials` is what scopes a WebAuthn assertion to an authenticator
   * that is already on file for this account, rather than letting the
   * authenticator pick any resident credential it has. A bare `id` is what
   * the spec wants here — public keys live in `getCredential` and are looked
   * up server-side after the assertion arrives, not shipped in the options.
   *
   * Returns an empty list when the account has no passkeys: the WebAuthn
   * caller's prompt will then offer nothing, which is the right answer —
   * step-up is impossible until the user has registered at least one.
   */
  async listCredentialsForStepUp(): Promise<
    { id: string; type: "public-key" }[]
  > {
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM credentials ORDER BY created_at`)
      .toArray();
    return rows.map((r) => ({ id: r.id, type: "public-key" }));
  }

  async listSessions(): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ token: string }>(`SELECT token FROM sessions ORDER BY claimed_at`)
      .toArray()
      .map((r) => r.token);
  }
}
