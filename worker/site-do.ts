import { DurableObject } from "cloudflare:workers";
import { summarise, type CallRow, type ToolSummary } from "./site-summary";

/**
 * One per origin. What agents did to this site's own WebMCP tools.
 *
 * Deliberately not the account's audit table, and deliberately not per user.
 * The two records answer to different people: the audit table is a person's
 * record of which of their profile fields travelled, and site telemetry is a
 * merchant's record of how their tools behaved for everyone. Keeping them
 * apart is what lets the audit table keep its promise — a store that has never
 * had a value column cannot grow one to serve a second purpose.
 *
 * So a row here has a tool, an outcome, a reason, a duration and a time, and
 * nothing that could identify who made the call.
 */
export class SiteDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS calls (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           tool TEXT NOT NULL,
           ok INTEGER NOT NULL,
           reason TEXT,
           ms INTEGER NOT NULL,
           ts INTEGER NOT NULL
         )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
    });
  }

  async recordCall(
    tool: string,
    ok: boolean,
    reason: string | null,
    ms: number,
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO calls (tool, ok, reason, ms, ts) VALUES (?, ?, ?, ?, ?)`,
      tool,
      ok ? 1 : 0,
      reason,
      Math.max(0, Math.round(ms)),
      Date.now(),
    );
  }

  async summary(limit = 5000): Promise<ToolSummary[]> {
    return summarise(
      this.ctx.storage.sql
        .exec<CallRow>(
          `SELECT tool, ok, reason, ms, ts FROM calls ORDER BY ts DESC LIMIT ?`,
          limit,
        )
        .toArray(),
    );
  }

  /**
   * Mint the token the owner publishes to prove they control the origin. The
   * same token is then the credential for reading — someone who could put a
   * file on the site is the audience for this data.
   */
  async issueToken(): Promise<{ token: string }> {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('token', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      token,
    );
    this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = 'verified'`);
    return { token };
  }

  async expectedToken(): Promise<string | null> {
    return this.readMeta("token");
  }

  async markVerified(): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('verified', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(Date.now()),
    );
  }

  /** Constant-time compare, and unverified origins never read. */
  async authorises(token: string): Promise<boolean> {
    if (!this.readMeta("verified")) return false;
    const expected = this.readMeta("token");
    if (!expected || expected.length !== token.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
    }
    return diff === 0;
  }

  private readMeta(key: string): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ value: string }>(`SELECT value FROM meta WHERE key = ? LIMIT 1`, key)
        .toArray()[0]?.value ?? null
    );
  }
}
