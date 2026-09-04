/**
 * Tests that `SessionDO.accountForPasskey` honours the session TTL.
 *
 * Every other session entry point (grantConsent, revokeConsent, listConsent,
 * the WebSocket accept bridge) refuses an expired session and throws
 * `Error("session expired")` so the worker can answer 410. Before this fix,
 * `accountForPasskey` skipped the check: a token past its TTL could still
 * mint a durable passkey bound to whatever account it had claimed. The DO
 * must now reject the same way.
 *
 * SessionDO extends `DurableObject` from `cloudflare:workers`, which the Node
 * test environment cannot resolve, so the base class is stubbed with one that
 * stores `ctx`/`env` the way the real one does. `ctx.storage.sql` is backed by
 * `node:sqlite` in memory, wrapped to the DO's
 * `exec(query, ...params) -> { toArray() }` shape. See session-do-consent.test.ts
 * for the same rig and the rationale.
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
import { handlePasskey } from "../worker/passkey-routes";

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

describe("SessionDO.accountForPasskey — expiry (H2)", () => {
  let ctx: FakeCtx;
  let sql: ReturnType<typeof makeSql>;
  let do_: SessionDO;

  beforeEach(() => {
    ({ ctx, sql } = makeCtx());
    do_ = makeDo(ctx);
  });

  it("refuses a passkey options call when the session has expired", async () => {
    await do_.initSession("t".repeat(64));
    expire(sql);
    await expect(do_.accountForPasskey()).rejects.toThrow("session expired");
  });

  it("still answers normally on a live session", async () => {
    await do_.initSession("t".repeat(64));
    // Bind an account id so the call has something to return; the test
    // proves expiry is the only thing that gates it.
    sql.exec(
      `INSERT INTO meta (key, value) VALUES ('accountId', ?)`,
      "a".repeat(64),
    );
    const { accountId } = await do_.accountForPasskey();
    expect(accountId).toBe("a".repeat(64));
  });
});

describe("passkey-routes register/options — session expiry translation (H2)", () => {
  const TOKEN = "b".repeat(64);
  const ACCOUNT = "a".repeat(64);

  function envWithExpiredSession(): Env {
    const accountForPasskey = vi.fn(async () => {
      // Match the worker's existing translation: a session past its TTL
      // throws "session expired" so the route can answer 410, identical
      // to grantConsent/revokeConsent/listConsent.
      throw new Error("session expired");
    });
    const addCredential = vi.fn(async () => ({ ok: true as const }));
    const kv = new Map<string, string>();
    return {
      SESSION: { getByName: vi.fn(() => ({ accountForPasskey })) },
      ACCOUNT: { getByName: vi.fn(() => ({ addCredential })) },
      OAUTH_TOKENS: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
        delete: async (k: string) => void kv.delete(k),
      },
    } as unknown as Env;
  }

  it("answers 410 when accountForPasskey throws 'session expired'", async () => {
    const env = envWithExpiredSession();
    const res = await handlePasskey(
      new Request("https://mcpmatic.test/account/passkey/register/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionToken: TOKEN }),
      }),
      env,
      "register/options",
    );
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      ok: false,
      error: "session expired",
    });
  });

  it("still answers 200 for a live session that has an account", async () => {
    const kv = new Map<string, string>();
    const accountForPasskey = vi.fn(async () => ({ accountId: ACCOUNT }));
    const addCredential = vi.fn(async () => ({ ok: true as const }));
    const env = {
      SESSION: { getByName: vi.fn(() => ({ accountForPasskey })) },
      ACCOUNT: { getByName: vi.fn(() => ({ addCredential })) },
      OAUTH_TOKENS: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
        delete: async (k: string) => void kv.delete(k),
      },
    } as unknown as Env;
    const res = await handlePasskey(
      new Request("https://mcpmatic.test/account/passkey/register/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionToken: TOKEN }),
      }),
      env,
      "register/options",
    );
    expect(res.status).toBe(200);
  });
});
