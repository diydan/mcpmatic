import { DurableObject } from "cloudflare:workers";
import { unionOrigins } from "../shared/origin";
import { AUDIT_DDL, type AuditRow } from "../shared/protocol";
import { toAuditRows, type StoredAuditRow } from "./audit-rows";

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

  async listSessions(): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ token: string }>(`SELECT token FROM sessions ORDER BY claimed_at`)
      .toArray()
      .map((r) => r.token);
  }
}
