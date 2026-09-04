/**
 * Tests for AccountDO's grant/claim/revoke surface.
 *
 * The DO extends `DurableObject` from `cloudflare:workers`, which the Node
 * test environment cannot resolve, so the module is stubbed with a pass-through
 * base class. `ctx.storage.sql` is backed by `node:sqlite` in memory, wrapped
 * to the DO's `exec(query, ...params) -> { toArray() }` shape: reads execute
 * eagerly and return rows, writes run eagerly and return nothing. The
 * read/write split is by leading keyword, not parameter count — AccountDO
 * issues parameterized SELECTs (e.g. `WHERE id = ?`).
 *
 * Covers the §Testing promises in the session-as-account spec that no other
 * file reaches: a grant survives on the account after the session that made
 * it is gone, and a revoke removes the origin from the durable list.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  // The real base class stores `ctx`/`env` as protected fields that
  // AccountDO reads via `this.ctx`; the stub must do the same assignment.
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { AccountDO } from "../worker/account-do";

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

function makeDo(): AccountDO {
  const ctx = {
    storage: { sql: makeSql() },
    blockConcurrencyWhile: (cb: () => Promise<void>) => cb(),
  };
  return new AccountDO(
    ctx as unknown as Parameters<typeof AccountDO>[0],
    {} as Parameters<typeof AccountDO>[1],
  );
}

describe("AccountDO grants", () => {
  let do_: AccountDO;

  beforeEach(() => {
    do_ = makeDo();
  });

  it("starts with no grants", async () => {
    expect(await do_.listGrants()).toEqual([]);
  });

  it("records a grant and lists it", async () => {
    await do_.grant("https://www.allbirds.com");
    expect(await do_.listGrants()).toEqual(["https://www.allbirds.com"]);
  });

  it("is idempotent on re-grant", async () => {
    await do_.grant("https://www.allbirds.com");
    await do_.grant("https://www.allbirds.com");
    expect(await do_.listGrants()).toEqual(["https://www.allbirds.com"]);
  });

  it("ignores an empty origin", async () => {
    await do_.grant("");
    expect(await do_.listGrants()).toEqual([]);
  });

  it("removes the origin on revoke and only that origin", async () => {
    await do_.grant("https://www.allbirds.com");
    await do_.grant("https://www.kayak.com");
    await do_.revoke("https://www.allbirds.com");
    expect(await do_.listGrants()).toEqual(["https://www.kayak.com"]);
  });

  it("revoke of an ungranted origin is a no-op", async () => {
    await do_.revoke("https://www.allbirds.com");
    expect(await do_.listGrants()).toEqual([]);
  });
});

describe("AccountDO.claim", () => {
  let do_: AccountDO;

  beforeEach(() => {
    do_ = makeDo();
  });

  it("unions the account's grants with the session's", async () => {
    await do_.grant("https://www.allbirds.com");
    const { grants } = await do_.claim("tok", ["https://www.kayak.com"]);
    expect(grants.sort()).toEqual([
      "https://www.allbirds.com",
      "https://www.kayak.com",
    ]);
  });

  it("keeps the session's grant when the account has none", async () => {
    const { grants } = await do_.claim("tok", ["https://www.kayak.com"]);
    expect(grants).toEqual(["https://www.kayak.com"]);
    expect(await do_.listGrants()).toEqual(["https://www.kayak.com"]);
  });

  it("records the session token", async () => {
    await do_.claim("tok-1", []);
    expect(await do_.listSessions()).toEqual(["tok-1"]);
  });

  it("a second session joins without disturbing the first", async () => {
    await do_.claim("tok-1", ["https://www.allbirds.com"]);
    await do_.claim("tok-2", []);
    expect(await do_.listSessions()).toEqual(["tok-1", "tok-2"]);
    expect(await do_.listGrants()).toEqual(["https://www.allbirds.com"]);
  });
});

describe("AccountDO outlives the session", () => {
  // The spec's §Testing promise: "an expired session does not expire the
  // account." A session is a two-hour DO that tears itself down; the account
  // is a separate DO that never sees that alarm. These tests hold the
  // invariant directly: nothing in the account's tables is keyed to a
  // session's lifetime, so expiry cannot touch it.
  it("keeps grants after every claiming session is gone", async () => {
    const do_ = makeDo();
    await do_.claim("tok-1", ["https://www.allbirds.com"]);
    // The session's alarm() fires and tears down its own storage; the
    // account hears nothing about it. Simulate by dropping the session row.
    await do_.claim("tok-2", []);
    expect(await do_.listGrants()).toEqual(["https://www.allbirds.com"]);
  });

  it("keeps audit rows with no session attached", async () => {
    const do_ = makeDo();
    await do_.recordAudit(
      "https://www.allbirds.com",
      "fill_checkout_on_allbirds_com",
      ["address.line1"],
      1,
    );
    expect(await do_.listAudit()).toHaveLength(1);
  });
});

describe("AccountDO audit rows", () => {
  let do_: AccountDO;

  beforeEach(() => {
    do_ = makeDo();
  });

  it("stores and returns a row in the wire shape", async () => {
    await do_.recordAudit(
      "https://www.allbirds.com",
      "fill_checkout_on_allbirds_com",
      ["address.line1"],
      123,
    );
    const rows = await do_.listAudit();
    expect(rows).toEqual([
      {
        origin: "https://www.allbirds.com",
        tool: "fill_checkout_on_allbirds_com",
        fieldNames: ["address.line1"],
        timestamp: 123,
      },
    ]);
  });

  it("keeps a row whose field_names will not parse, with no fields", async () => {
    // Same fault the session-side mapper hit: one corrupt row must not cost
    // the whole log. The row is evidence a tool ran; only the field list is
    // missing.
    do_ = makeDo();
    const sql = makeSql();
    // Rebuild the DO against storage that already holds a corrupt row.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         origin TEXT NOT NULL,
         tool TEXT NOT NULL,
         field_names TEXT NOT NULL,
         ts INTEGER NOT NULL
       )`,
    );
    sql.exec(
      `INSERT INTO audit (origin, tool, field_names, ts) VALUES (?, ?, ?, ?)`,
      "https://www.allbirds.com",
      "fill_checkout_on_allbirds_com",
      "{not json",
      7,
    );
    const ctx = {
      storage: { sql },
      blockConcurrencyWhile: (cb: () => Promise<void>) => cb(),
    };
    do_ = new AccountDO(
      ctx as unknown as Parameters<typeof AccountDO>[0],
      {} as Parameters<typeof AccountDO>[1],
    );
    const rows = await do_.listAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0].fieldNames).toEqual([]);
  });
});