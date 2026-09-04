/**
 * End-to-end coverage for the step-up flow that binds /s/<token>/account to
 * a fresh WebAuthn assertion.
 *
 * The unit tests in `tests/step-up.test.ts` cover the KV-backed token
 * lifecycle directly; this file proves the SessionDO side rejects a forged
 * step-up token under the same conditions. A forged token means:
 *   - a token that was never minted;
 *   - a token minted against a different session;
 *   - a token minted against a different account;
 *   - a token whose record has been consumed (replay);
 *   - a token with the right shape but a missing `kind: "stepup"` field.
 *
 * SessionDO extends `DurableObject` from `cloudflare:workers`, which the
 * Node test environment cannot resolve, so the base class is stubbed.
 * `ctx.storage.sql` is backed by `node:sqlite` in memory; `env.OAUTH_TOKENS`
 * is a real Map so the take-side single-use check actually fires.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.stubGlobal(
  "WebSocketRequestResponsePair",
  class {
    constructor(public request: string, public response: string) {}
  },
);

import { SessionDO } from "../worker/session-do";
import { mintStepUp } from "../worker/passkey-challenge";

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
    storage: { sql, transactionSync: (cb) => cb() },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: (cb) => cb(),
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn(() => []),
  };
  return { ctx, sql };
}

function makeDo(ctx: FakeCtx, kv: Map<string, string>): SessionDO {
  const env: {
    ACCOUNT: { getByName: ReturnType<typeof vi.fn> };
    OAUTH_TOKENS: {
      get: (k: string) => Promise<string | null>;
      put: (k: string, v: string, o?: unknown) => Promise<void>;
      delete: (k: string) => Promise<void>;
    };
    MANIFEST_REGISTRY: undefined;
  } = {
    ACCOUNT: {
      // getByName is replaced per-test with one whose `claim` spy is
      // observable. The SessionDO captures `env` at construction, so the
      // replacement must be on the same object it already holds.
      getByName: vi.fn(),
    },
    OAUTH_TOKENS: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string, _o?: unknown) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    MANIFEST_REGISTRY: undefined,
  };
  const do_ = new SessionDO(
    ctx as unknown as Parameters<typeof SessionDO>[0],
    env as unknown as Parameters<typeof SessionDO>[1],
  );
  (ctx as unknown as { env: unknown }).env = env;
  return do_;
}

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const SESSION_X = "c".repeat(64);
const SESSION_Y = "d".repeat(64);
const STEP_UP = "e".repeat(64);

describe("claimAccountWithStepUp — rejects forgery", () => {
  let ctx: FakeCtx;
  let kv: Map<string, string>;
  let do_: SessionDO;
  let claim: ReturnType<typeof vi.fn>;
  let env: {
    ACCOUNT: { getByName: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    ({ ctx } = makeCtx());
    kv = new Map();
    do_ = makeDo(ctx, kv);
    env = (ctx as unknown as { env: typeof env }).env;
    claim = vi.fn(async () => ({ grants: ["https://www.allbirds.com"] }));
    env.ACCOUNT.getByName = vi.fn(() => ({ claim }));
    // Plant the session's token row so claimAccountWithStepUp has something
    // to bind against. Without it, every test short-circuits on "no session".
    await do_.initSession(SESSION_X);
  });

  it("rejects a token that was never minted", async () => {
    const result = await do_.claimAccountWithStepUp(ACCOUNT_A, STEP_UP);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("step-up invalid");
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects a token minted for a different session", async () => {
    // SESSION_Y produced the token, but this DO holds SESSION_X. A token
    // leaked from another session cannot claim this one.
    await mintStepUp(kvAdapter(kv), STEP_UP, {
      accountId: ACCOUNT_A,
      sessionToken: SESSION_Y,
    });
    const result = await do_.claimAccountWithStepUp(ACCOUNT_A, STEP_UP);
    expect(result.ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects a token minted for a different account", async () => {
    await mintStepUp(kvAdapter(kv), STEP_UP, {
      accountId: ACCOUNT_B,
      sessionToken: SESSION_X,
    });
    const result = await do_.claimAccountWithStepUp(ACCOUNT_A, STEP_UP);
    expect(result.ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects a replayed token after a successful claim", async () => {
    // Same-session, same-account token is consumed on first claim; a second
    // claim sees no record and must fail.
    await mintStepUp(kvAdapter(kv), STEP_UP, {
      accountId: ACCOUNT_A,
      sessionToken: SESSION_X,
    });
    const first = await do_.claimAccountWithStepUp(ACCOUNT_A, STEP_UP);
    expect(first.ok).toBe(true);
    claim.mockClear();
    const second = await do_.claimAccountWithStepUp(ACCOUNT_A, STEP_UP);
    expect(second.ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects a record whose `kind` discriminator is missing", async () => {
    // A record under the stepup:* namespace without `kind: "stepup"` is
    // not a step-up token, regardless of how its other fields look.
    kv.set(
      `stepup:${STEP_UP}`,
      JSON.stringify({ accountId: ACCOUNT_A, sessionToken: SESSION_X }),
    );
    const result = await do_.claimAccountWithStepUp(ACCOUNT_A, STEP_UP);
    expect(result.ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it("accepts a token minted for this session and account, and runs the claim", async () => {
    await mintStepUp(kvAdapter(kv), STEP_UP, {
      accountId: ACCOUNT_A,
      sessionToken: SESSION_X,
    });
    const result = await do_.claimAccountWithStepUp(ACCOUNT_A, STEP_UP);
    expect(result.ok).toBe(true);
    expect(claim).toHaveBeenCalledWith(
      SESSION_X,
      // Whatever consent the session had before the claim; empty here.
      expect.any(Array),
    );
  });
});

function kvAdapter(kv: Map<string, string>): {
  get: (k: string) => Promise<string | null>;
  put: (k: string, v: string, o?: unknown) => Promise<void>;
  delete: (k: string) => Promise<void>;
} {
  return {
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => void kv.set(k, v),
    delete: async (k) => void kv.delete(k),
  };
}