/**
 * @vitest-environment node
 *
 * The tool surface has to agree with the SYSTEM prompt.
 *
 * The prompt says "You may navigate to any https site", but `navigate_to`'s
 * description still read "Navigate the remote browser to an https origin the
 * user has granted", and `list_available_origins` answered with the four
 * catalog origins under the key `known`. A model that reads the tool
 * description over the prompt concludes it cannot go anywhere new and falls
 * back to the catalog — which silently no-ops the whole open-web change.
 *
 * The façade half of the same surface (`src/lib/register-all.ts`) needs a DOM,
 * so it is asserted in `registration.test.ts` instead.
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

import { buildToolList } from "../worker/mcp/tools";
import { initialMessages } from "../worker/agent";
import { SessionDO } from "../worker/session-do";

/**
 * Phrasings that make navigation conditional on a prior grant. Any of these in
 * `navigate_to`'s description contradicts the prompt, and the description is
 * what an MCP client actually ships to its model.
 */
const RESTRICTIVE: RegExp[] = [
  /origin the user has granted/i,
  /\ba granted origin\b/i,
  /must (already )?be granted/i,
  /only .{0,24}\bgranted\b/i,
  /\bgranted origins? only\b/i,
];

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

function makeDo(): SessionDO {
  const ctx = {
    storage: { sql: makeSql(), transactionSync: (cb: () => void) => cb() },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: (cb: () => Promise<void>) => cb(),
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn(() => []),
  };
  const env = {
    ACCOUNT: { getByName: vi.fn(() => ({ grant: vi.fn(), claim: vi.fn() })) },
    SITE: { getByName: vi.fn(() => ({ recordCall: vi.fn() })) },
    MANIFEST_REGISTRY: undefined,
    // Truthy so `get_page_state` reports the "no browser yet" case rather
    // than the "no binding in this environment" one.
    BROWSER: {},
  };
  return new SessionDO(
    ctx as unknown as Parameters<typeof SessionDO>[0],
    env as unknown as Parameters<typeof SessionDO>[1],
  );
}

async function spineDescription(name: string): Promise<string> {
  const listed = await buildToolList(new Set());
  const tool = listed.find((t) => t.name === name);
  expect(tool, `${name} is missing from the MCP spine`).toBeDefined();
  return tool!.description;
}

describe("navigate_to's description (MCP surface)", () => {
  it("does not restrict navigation to already-granted origins", async () => {
    const description = await spineDescription("navigate_to");
    for (const pattern of RESTRICTIVE) {
      expect(description).not.toMatch(pattern);
    }
  });

  it("licenses any https site, as the SYSTEM prompt does", async () => {
    const description = await spineDescription("navigate_to");
    expect(description).toMatch(/any https site/i);
    // The two must not be able to drift apart again without a test failing.
    const system = String(initialMessages("plan a trip")[0].content);
    expect(system).toMatch(/any https site/i);
  });

  it("says a site with no tools yet is still a destination", async () => {
    const description = await spineDescription("navigate_to");
    expect(description).toMatch(/sites that already have tools/i);
  });
});

describe("list_available_origins (MCP surface)", () => {
  it("does not present its answer as the set of visitable sites", async () => {
    const description = await spineDescription("list_available_origins");
    expect(description).toMatch(/navigate_to reaches any https site/i);
    expect(description).not.toBe("Origins this session may act on, after consent.");
  });
});

describe("list_available_origins (result payload)", () => {
  it("labels the catalog as pre-wired examples, not as what is known to exist", async () => {
    const do_ = makeDo();
    await do_.initSession("t".repeat(64));

    const res = await do_.callTool("list_available_origins", {});
    const body = JSON.parse(res.text) as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(body).toHaveProperty("preWired");
    // `known: [the four catalog origins]` is exactly the closed list spec §2
    // forbids, and it is the key a model reads as "what exists".
    expect(body).not.toHaveProperty("known");
    expect(String(body.note)).toMatch(/any https site/i);
  });

  it("still reports what this session has consented to", async () => {
    const do_ = makeDo();
    await do_.initSession("t".repeat(64), "https://www.kayak.com");

    const res = await do_.callTool("list_available_origins", {});
    const body = JSON.parse(res.text) as { consented: string[] };

    expect(body.consented).toEqual(["https://www.kayak.com"]);
  });
});

describe("get_page_state with no browser yet", () => {
  it("names navigate_to on any https site, not a grant, as the unblock", async () => {
    const do_ = makeDo();
    await do_.initSession("t".repeat(64));

    const res = await do_.callTool("get_page_state", {});

    expect(res.text).toMatch(/any https site/i);
    expect(res.text).not.toMatch(/Grant an origin/i);
  });
});
