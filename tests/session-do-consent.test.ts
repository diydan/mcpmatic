/**
 * Tests for SessionDO's consent surface and the TTL rules it
 * exercises: the clock starts at mint, and every consent route refuses an
 * expired session.
 *
 * SessionDO extends `DurableObject` from `cloudflare:workers`, which the Node
 * test environment cannot resolve, so the base class is stubbed with one that
 * stores `ctx`/`env` the way the real one does. `ctx.storage.sql` is backed by
 * `node:sqlite` in memory, wrapped to the DO's
 * `exec(query, ...params) -> { toArray() }` shape (reads execute eagerly and
 * return rows; writes run eagerly; the read/write split is by leading
 * keyword, not parameter count — the DO issues parameterized SELECTs).
 *
 * The env here is the minimum the consent methods touch: ACCOUNT (only when
 * the session is claimed) and MANIFEST_REGISTRY (only listTools reads it).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  // The real base class stores `ctx`/`env` as protected fields that
  // SessionDO reads via `this.ctx`; the stub must do the same assignment.
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// `WebSocketRequestResponsePair` is a workers-runtime global, not a module
// export — the constructor's ping/pong registration reads it as a bare
// identifier. Stub it on globalThis before the DO is constructed.
vi.stubGlobal(
  "WebSocketRequestResponsePair",
  class {
    constructor(
      public request: string,
      public response: string,
    ) {}
  },
);

import { SessionDO } from "../worker/session-do";
import { MANIFESTS } from "../worker/manifests";

function makeSql() {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare: (q: string) => {
        all: (...p: unknown[]) => Array<Record<string, unknown>>;
        run: (...p: unknown[]) => unknown;
      };
    };
  };
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query: string, ...params: unknown[]) => {
      const stmt = db.prepare(query);
      const isRead = /^\s*(SELECT|PRAGMA)/i.test(query);
      if (isRead) {
        const rows = params.length ? stmt.all(...params) : stmt.all();
        return { toArray: () => rows.map((r) => ({ ...r })) };
      }
      if (params.length) stmt.run(...params);
      else stmt.run();
      return { toArray: () => [] };
    },
  };
}

type FakeCtx = {
  storage: {
    sql: ReturnType<typeof makeSql>;
    transactionSync: (cb: () => void) => void;
  };
  waitUntil: ReturnType<typeof vi.fn>;
  blockConcurrencyWhile: (cb: () => Promise<void>) => Promise<void>;
  setWebSocketAutoResponse: ReturnType<typeof vi.fn>;
  getWebSockets: ReturnType<typeof vi.fn>;
};

function makeCtx(): { ctx: FakeCtx; sql: ReturnType<typeof makeSql> } {
  const sql = makeSql();
  const ctx: FakeCtx = {
    storage: {
      sql,
      // initSession wraps its writes in one transaction; node:sqlite is
      // already auto-commit per statement, so run the callback directly.
      transactionSync: (cb) => cb(),
    },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: (cb) => cb(),
    // SessionDO's constructor registers a ping/pong auto-response pair.
    setWebSocketAutoResponse: vi.fn(),
    // No sockets attached in these tests: grantConsent's browser-launch
    // branch is skipped, which is what a headless caller looks like.
    getWebSockets: vi.fn(() => []),
  };
  return { ctx, sql };
}

function makeDo(ctx: FakeCtx): SessionDO {
  // Mutable so a test can swap in a mock ACCOUNT after construction — the DO
  // captured `env` at construction time, so replacement must happen on the
  // same object it holds, not on a fresh one.
  const env = {
    ACCOUNT: { getByName: vi.fn(() => ({ claim: vi.fn(), revoke: vi.fn() })) },
    MANIFEST_REGISTRY: undefined,
  };
  const do_ = new SessionDO(
    ctx as unknown as Parameters<typeof SessionDO>[0],
    env as unknown as Parameters<typeof SessionDO>[1],
  );
  (ctx as unknown as { env: unknown }).env = env;
  return do_;
}

/** Age the session's createdAt row by the full TTL plus a minute. */
function expire(sql: ReturnType<typeof makeSql>): void {
  const twoHours = 2 * 60 * 60 * 1000;
  sql.exec(
    `INSERT INTO meta (key, value) VALUES ('createdAt', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(Date.now() - twoHours - 60_000),
  );
}

describe("SessionDO consent — TTL", () => {
  let ctx: FakeCtx;
  let sql: ReturnType<typeof makeSql>;
  let do_: SessionDO;

  beforeEach(() => {
    ({ ctx, sql } = makeCtx());
    do_ = makeDo(ctx);
  });

  it("persists createdAt at mint, before any bridge connects", async () => {
    await do_.initSession("t".repeat(64));
    const row = sql
      .exec(`SELECT value FROM meta WHERE key = 'createdAt' LIMIT 1`)
      .toArray()[0];
    expect(row).toBeDefined();
    // Within a second of the call — the mint, not some later accept.
    expect(Date.now() - Number(row!.value)).toBeLessThan(1_000);
  });

  it("a replay of initSession does not reset the clock", async () => {
    await do_.initSession("t".repeat(64));
    expire(sql);
    await do_.initSession("t".repeat(64));
    const row = sql
      .exec(`SELECT value FROM meta WHERE key = 'createdAt' LIMIT 1`)
      .toArray()[0];
    // Still the expired timestamp: the clock was not restarted.
    expect(Date.now() - Number(row!.value)).toBeGreaterThan(2 * 60 * 60 * 1000);
  });

  it("grantConsent refuses an expired session", async () => {
    await do_.initSession("t".repeat(64));
    expire(sql);
    await expect(do_.grantConsent("https://www.allbirds.com")).rejects.toThrow(
      "session expired",
    );
  });

  it("revokeConsent refuses an expired session", async () => {
    await do_.initSession("t".repeat(64));
    expire(sql);
    await expect(do_.revokeConsent("https://www.allbirds.com")).rejects.toThrow(
      "session expired",
    );
  });

  it("listConsent refuses an expired session", async () => {
    await do_.initSession("t".repeat(64));
    expire(sql);
    await expect(do_.listConsent()).rejects.toThrow("session expired");
  });

  it("a live session still grants, revokes and lists normally", async () => {
    await do_.initSession("t".repeat(64));
    await do_.grantConsent("https://www.allbirds.com");
    await do_.revokeConsent("https://www.allbirds.com");
    const { consent } = await do_.listConsent();
    expect(consent).toEqual([]);
  });
});

describe("SessionDO consent — grant/revoke round trip", () => {
  let ctx: FakeCtx;
  let do_: SessionDO;

  beforeEach(() => {
    ({ ctx } = makeCtx());
    do_ = makeDo(ctx);
  });

  it("grant then revoke leaves the list empty", async () => {
    await do_.initSession("t".repeat(64));
    await do_.grantConsent("https://www.allbirds.com");
    const afterGrant = await do_.listConsent();
    expect(afterGrant.consent).toEqual(["https://www.allbirds.com"]);
    const { consent } = await do_.revokeConsent("https://www.allbirds.com");
    expect(consent).toEqual([]);
  });

  it("revoking an ungranted origin is a no-op", async () => {
    await do_.initSession("t".repeat(64));
    await do_.grantConsent("https://www.allbirds.com");
    const { consent } = await do_.revokeConsent("https://www.kayak.com");
    expect(consent).toEqual(["https://www.allbirds.com"]);
  });

  it("revoke writes through to the claiming account", async () => {
    await do_.initSession("t".repeat(64));
    const revoke = vi.fn(async (_o: string) => ({ ok: true as const }));
    const claim = vi.fn(async () => ({
      grants: ["https://www.allbirds.com"],
    }));
    // Swap the mock ACCOUNT in on the env object the DO already holds.
    const env = (ctx as unknown as { env: { ACCOUNT: unknown } }).env;
    env.ACCOUNT = { getByName: vi.fn(() => ({ claim, revoke })) };
    await do_.claimAccount("a".repeat(64));
    await do_.revokeConsent("https://www.allbirds.com");
    expect(revoke).toHaveBeenCalledWith("https://www.allbirds.com");
  });
});

/**
 * Autonomous mode is the model-driven path. Two flags control it now:
 *   `autonomous`     — catalog origins are auto-granted as soon as the
 *                      session is set up.
 *   `autoGrantNew`   — origins *outside* the catalog are auto-granted
 *                      only when this is on.
 * The split exists so the two can be controlled separately (M9): catalog
 * automation can stay on while off-catalog auto-granting is turned off.
 * Both default to **on** — automation is the product default, and the gate
 * that matters is a profile value leaving the device, not which tools are
 * listed. Only an explicit "0" narrows either one.
 *
 * `allowOrigin` is private; we reach it via the same `as unknown` cast
 * the rest of this file uses for internal access. The function returns
 * `false` rather than throwing when a non-catalog origin arrives without
 * the second flag, so the four navigation call sites return a clean
 * `{ ok: false }` instead of crashing.
 */
describe("SessionDO autonomous — autoGrantNew gate (M9)", () => {
  let ctx: FakeCtx;
  let do_: SessionDO;

  beforeEach(() => {
    ({ ctx } = makeCtx());
    do_ = makeDo(ctx);
  });

  // A catalog origin from MANIFESTS. The test does not assert which one —
  // just that it is in the catalog and is auto-granted as soon as
  // `autonomous` is on, with or without `autoGrantNew`.
  const catalogOrigin: string = MANIFESTS[0].origin;
  const offCatalogOrigin = "https://www.example-store.example";

  // Reach the private method via the same cast trick the file already uses.
  const allowOrigin = (origin: string) =>
    (do_ as unknown as { allowOrigin: (o: string) => Promise<boolean> })
      .allowOrigin(origin);

  it("catalog origin is auto-granted with autonomous on, autoGrantNew off", async () => {
    await do_.initSession("t".repeat(64));
    await do_.setAutonomous(true, false);
    expect(await allowOrigin(catalogOrigin)).toBe(true);
  });

  it("off-catalog origin is auto-granted only when autoGrantNew is on", async () => {
    await do_.initSession("t".repeat(64));
    await do_.setAutonomous(true, false);
    // Without the second flag, the gate closes.
    expect(await allowOrigin(offCatalogOrigin)).toBe(false);
    // And the origin must NOT be in the consent list.
    const { consent } = await do_.listConsent();
    expect(consent).not.toContain(offCatalogOrigin);

    // Turning the second flag on opens the gate.
    await do_.setAutonomous(true, true);
    expect(await allowOrigin(offCatalogOrigin)).toBe(true);
  });

  it("a fresh session auto-grants both, because automation is the default", async () => {
    await do_.initSession("t".repeat(64));
    // Do NOT call setAutonomous. An absent row means on for both flags, so a
    // session nobody has configured acts rather than asking per origin.
    expect(await allowOrigin(catalogOrigin)).toBe(true);
    expect(await allowOrigin(offCatalogOrigin)).toBe(true);
  });

  it("autonomous explicitly off: nothing is auto-granted, even on the catalog", async () => {
    await do_.initSession("t".repeat(64));
    // An explicit choice outranks the default and must survive.
    await do_.setAutonomous(false);
    expect(await allowOrigin(catalogOrigin)).toBe(false);
    expect(await allowOrigin(offCatalogOrigin)).toBe(false);
    const { consent } = await do_.listConsent();
    expect(consent).toEqual([]);
  });

  it("explicit grantConsent still works regardless of the auto flags", async () => {
    // The public, user-driven path bypasses `allowOrigin` entirely —
    // a user clicking "grant" must always succeed, even with autonomous
    // off and autoGrantNew off.
    await do_.initSession("t".repeat(64));
    await do_.grantConsent(offCatalogOrigin);
    const { consent } = await do_.listConsent();
    expect(consent).toContain(offCatalogOrigin);
  });
});