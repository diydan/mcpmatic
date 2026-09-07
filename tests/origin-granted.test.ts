/**
 * @vitest-environment node
 *
 * allowOrigin auto-grants; until now it did so silently. Spec §3: an origin
 * the model picked must appear in the transcript, so allowOrigin broadcasts
 * exactly once on the transition and never for an origin already consented.
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
    constructor(
      public request: string,
      public response: string,
    ) {}
  },
);

import { SessionDO } from "../worker/session-do";

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

type Sent = Record<string, unknown>;

function makeDo(): { do_: SessionDO; sent: Sent[] } {
  const sql = makeSql();
  const sent: Sent[] = [];
  // One fake socket. `broadcast` writes to every socket returned here, so
  // capturing send() is how we observe what the DO emitted.
  const socket = {
    send: (raw: string) => sent.push(JSON.parse(raw) as Sent),
    readyState: 1,
  };
  const ctx = {
    storage: { sql, transactionSync: (cb: () => void) => cb() },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: (cb: () => Promise<void>) => cb(),
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn(() => [socket]),
  };
  const env = {
    ACCOUNT: { getByName: vi.fn(() => ({ grant: vi.fn(), claim: vi.fn() })) },
    MANIFEST_REGISTRY: undefined,
    BROWSER: undefined,
  };
  const do_ = new SessionDO(
    ctx as unknown as Parameters<typeof SessionDO>[0],
    env as unknown as Parameters<typeof SessionDO>[1],
  );
  return { do_, sent };
}

const grants = (sent: Sent[]) => sent.filter((m) => m.type === "origin_granted");

// `allowOrigin` is private, so these drive `grantConsent` directly — that is
// where the broadcast lives, and `allowOrigin`'s only job here is to pass
// "model" through to it (asserted by the passthrough change in Step 5).
describe("grantConsent broadcasts the grant transition", () => {
  let do_: SessionDO;
  let sent: Sent[];

  beforeEach(async () => {
    ({ do_, sent } = makeDo());
    await do_.initSession("t".repeat(64), undefined);
    sent.length = 0;
  });

  it("emits origin_granted once when it auto-grants a new origin", async () => {
    // autonomous and autoGrantNew both default on, so this is the
    // no-click path the product relies on.
    await do_.grantConsent("https://www.example.com", "model");
    const seen = grants(sent);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "origin_granted",
      origin: "https://www.example.com",
      source: "model",
    });
  });

  it("does not emit again for an origin already consented", async () => {
    await do_.grantConsent("https://www.example.com", "model");
    sent.length = 0;
    await do_.grantConsent("https://www.example.com", "model");
    expect(grants(sent)).toHaveLength(0);
  });

  it("marks a user-typed grant as such", async () => {
    await do_.grantConsent("https://www.example.com");
    expect(grants(sent)[0]).toMatchObject({ source: "user" });
  });
});

describe("account write-through", () => {
  function makeDoWithAccount() {
    const sql = makeSql();
    const grant = vi.fn(async () => ({ ok: true as const }));
    const account = { grant, claim: vi.fn(), revoke: vi.fn() };
    const ctx = {
      storage: { sql, transactionSync: (cb: () => void) => cb() },
      // grantConsent defers the account write with waitUntil; run it eagerly
      // so the assertion does not race the promise.
      waitUntil: (p: Promise<unknown>) => void p,
      blockConcurrencyWhile: (cb: () => Promise<void>) => cb(),
      setWebSocketAutoResponse: vi.fn(),
      getWebSockets: vi.fn(() => []),
    };
    const env = {
      ACCOUNT: { getByName: vi.fn(() => account) },
      MANIFEST_REGISTRY: undefined,
      BROWSER: undefined,
    };
    const do_ = new SessionDO(
      ctx as unknown as Parameters<typeof SessionDO>[0],
      env as unknown as Parameters<typeof SessionDO>[1],
    );
    return { do_, grant, sql };
  }

  it("writes a user-typed origin through to the account", async () => {
    const { do_, grant, sql } = makeDoWithAccount();
    await do_.initSession("u".repeat(64), undefined);
    sql.exec(
      `INSERT INTO meta (key, value) VALUES ('accountId', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      "acct_1",
    );
    await do_.grantConsent("https://typed.example.com", "user");
    expect(grant).toHaveBeenCalledWith("https://typed.example.com");
  });

  it("keeps a model-picked origin session-scoped", async () => {
    // Spec §5: without this a roaming agent permanently enlarges the
    // account's grant set, and every future session inherits it.
    const { do_, grant, sql } = makeDoWithAccount();
    await do_.initSession("m".repeat(64), undefined);
    sql.exec(
      `INSERT INTO meta (key, value) VALUES ('accountId', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      "acct_1",
    );
    await do_.grantConsent("https://wandered.example.com", "model");
    expect(grant).not.toHaveBeenCalled();
  });
});
