/**
 * @vitest-environment node
 *
 * Regression for the reported bug: clicking a chip seeded with kayak.com
 * produced a session consented to allbirds.com, because AccountDO.claim
 * returns the account's whole grant history and claimAccount wrote it into
 * session consent. Spec §5 — the account list is a capability, not this
 * session's active state.
 */
import { describe, expect, it, vi } from "vitest";

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

const KAYAK = "https://www.kayak.com";
const ALLBIRDS = "https://www.allbirds.com";
/** Somewhere the agent wandered on its own. Never named by the human. */
const WANDERED = "https://www.wandered.example";

function makeDo() {
  const sql = makeSql();
  // The account already holds allbirds from some earlier session, and its
  // claim() returns the union — that is AccountDO's real contract.
  const claim = vi.fn(async (_token: string, sessionGrants: string[]) => ({
    grants: [ALLBIRDS, ...sessionGrants.filter((o) => o !== ALLBIRDS)],
  }));
  const ctx = {
    storage: { sql, transactionSync: (cb: () => void) => cb() },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: (cb: () => Promise<void>) => cb(),
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn(() => []),
  };
  const env = {
    ACCOUNT: { getByName: vi.fn(() => ({ claim, grant: vi.fn() })) },
    MANIFEST_REGISTRY: undefined,
    BROWSER: undefined,
  };
  const do_ = new SessionDO(
    ctx as unknown as Parameters<typeof SessionDO>[0],
    env as unknown as Parameters<typeof SessionDO>[1],
  );
  return { do_, claim };
}

describe("claimAccount", () => {
  it("does not pull the account's history into session consent", async () => {
    const { do_ } = makeDo();
    await do_.initSession("k".repeat(64), KAYAK);

    const res = await do_.claimAccount("acct_1");

    expect(res.ok).toBe(true);
    expect(res.consent).toEqual([KAYAK]);
    expect(res.consent).not.toContain(ALLBIRDS);
  });

  it("still merges the session's own grants up into the account", async () => {
    // The account must still learn what this session granted — that half of
    // the contract is what makes a grant outlive the session.
    const { do_, claim } = makeDo();
    await do_.initSession("k".repeat(64), KAYAK);

    await do_.claimAccount("acct_1");

    expect(claim).toHaveBeenCalledWith("k".repeat(64), [KAYAK]);
  });

  /**
   * Spec §5. `grantConsent` already refuses to call `ACCOUNT.grant()` for a
   * model-picked origin, but `claimAccount` handed the whole untagged consent
   * list to `AccountDO.claim`, which grants every entry it receives — so the
   * durable set still grew every time the agent wandered, by a second route.
   */
  describe("model-picked origins stay out of the account", () => {
    it("does not push a model-picked origin up into the account", async () => {
      const { do_, claim } = makeDo();
      await do_.initSession("k".repeat(64), KAYAK);
      await do_.grantConsent(WANDERED, "model");

      await do_.claimAccount("acct_1");

      expect(claim).toHaveBeenCalledWith("k".repeat(64), [KAYAK]);
    });

    it("still lists the model-picked origin in this session's consent", async () => {
      // Session-scoped, not hidden: the Consent panel must still show it with
      // its revoke button. Only the durable write is withheld.
      const { do_ } = makeDo();
      await do_.initSession("k".repeat(64), KAYAK);
      await do_.grantConsent(WANDERED, "model");

      const { consent } = await do_.listConsent();
      expect(consent).toEqual([KAYAK, WANDERED]);
    });

    it("an explicit human grant upgrades the origin to durable", async () => {
      const { do_, claim } = makeDo();
      await do_.initSession("k".repeat(64), KAYAK);
      await do_.grantConsent(WANDERED, "model");
      // The user sees it in the Consent panel and grants it deliberately.
      await do_.grantConsent(WANDERED, "user");

      await do_.claimAccount("acct_1");

      expect(claim).toHaveBeenCalledWith("k".repeat(64), [KAYAK, WANDERED]);
    });

    it("a later model navigation cannot demote a human-granted origin", async () => {
      const { do_, claim } = makeDo();
      await do_.initSession("k".repeat(64), KAYAK);
      await do_.grantConsent(WANDERED, "user");
      // allowOrigin short-circuits on an already-consented origin, but a
      // direct model grant must not re-tag it either.
      await do_.grantConsent(WANDERED, "model");

      await do_.claimAccount("acct_1");

      expect(claim).toHaveBeenCalledWith("k".repeat(64), [KAYAK, WANDERED]);
    });

    it("revoking clears the tag, so a later human grant goes up", async () => {
      const { do_, claim } = makeDo();
      await do_.initSession("k".repeat(64), KAYAK);
      await do_.grantConsent(WANDERED, "model");
      await do_.revokeConsent(WANDERED);
      await do_.grantConsent(WANDERED, "user");

      await do_.claimAccount("acct_1");

      expect(claim).toHaveBeenCalledWith("k".repeat(64), [KAYAK, WANDERED]);
    });

    it("the origin the session was seeded with is never model-picked", async () => {
      // POST /sessions carries a human's typed URL or recent-site click.
      const { do_, claim } = makeDo();
      await do_.initSession("k".repeat(64), KAYAK);

      await do_.claimAccount("acct_1");

      expect(claim).toHaveBeenCalledWith("k".repeat(64), [KAYAK]);
    });
  });

  it("records the account id so later grants can write through", async () => {
    const { do_ } = makeDo();
    await do_.initSession("k".repeat(64), KAYAK);

    await do_.claimAccount("acct_1");
    // A second claim of the same account is allowed; a different one is not.
    // claimDecision enforces that, and it reads the id this call stored.
    const again = await do_.claimAccount("acct_2");
    expect(again.ok).toBe(false);
  });
});
