/**
 * @vitest-environment node
 *
 * The DO half of spec §6's backstop.
 *
 * The client's render fallback opens the user's *last* site, which has nothing
 * to do with the task in hand. Its only navigation mechanism used to be
 * `executeTool(navigate_to, …)`, which routes through `allowOrigin` — and
 * `allowOrigin` auto-grants. So the fallback silently reproduced the bug this
 * whole branch exists to fix: an unrelated origin in `consented`, rendered
 * granted-with-revoke in the Consent panel, with its tools (a profile-filling
 * `fill_checkout` among them) registered on a trip-planning task.
 *
 * `render_fallback` is the render-only path. It keeps every SSRF check and
 * stops short of the grant. These tests hold both halves of that: it does
 * navigate, and it grants nothing.
 *
 * Same harness as `userinfo-rejection.test.ts`: the `cloudflare:workers` base
 * class is stubbed and `ctx.storage.sql` is backed by `node:sqlite`.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

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

const LAST_SITE = "https://www.allbirds.com";

type Sent = Record<string, unknown>;

/**
 * A session with an already-open browser and empty consent — so anything that
 * appears in the consent list came from the message under test, and a refusal
 * cannot be blamed on a missing Browser Rendering binding.
 */
async function makeHarness() {
  const sql = makeSql();
  const sent: Sent[] = [];
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
    SITE: { getByName: vi.fn(() => ({ recordCall: vi.fn() })) },
    MANIFEST_REGISTRY: undefined,
    BROWSER: {},
  };
  const do_ = new SessionDO(
    ctx as unknown as Parameters<typeof SessionDO>[0],
    env as unknown as Parameters<typeof SessionDO>[1],
  );
  await do_.initSession("t".repeat(64));
  let current = "about:blank";
  const goto = vi.fn(async (url: string) => {
    current = url;
  });
  const evaluate = vi.fn(async () => undefined);
  // ensureBrowser short-circuits on an already-live browser, so this stands
  // in for Chromium without a Browser Rendering binding.
  (do_ as unknown as { live: unknown }).live = {
    browser: { close: async () => {} },
    page: {
      goto,
      url: () => current,
      title: async () => "",
      innerText: async () => "",
      evaluate,
      context: () => ({}),
    },
  };
  sent.length = 0;
  return { do_, goto, sent };
}

const ws = {} as WebSocket;

function renderFallback(origin: string): string {
  return JSON.stringify({ v: 1, type: "render_fallback", origin });
}

/**
 * A DoH answer with a single public address and a TTL above the 30 s floor,
 * returned for both the A and AAAA query and for both of `navigationStable`'s
 * two resolutions — so the guard passes rather than being bypassed.
 */
function stubPublicDns() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) =>
      String(url).includes("type=AAAA")
        ? new Response(JSON.stringify({ Status: 0, Answer: [] }), {
            headers: { "content-type": "application/dns-json" },
          })
        : new Response(
            JSON.stringify({
              Status: 0,
              Answer: [{ type: 1, TTL: 300, data: "93.184.216.34" }],
            }),
            { headers: { "content-type": "application/dns-json" } },
          ),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "WebSocketRequestResponsePair",
    class {
      constructor(
        public request: string,
        public response: string,
      ) {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("render_fallback puts a page on screen", () => {
  it("navigates to the origin it was given", async () => {
    stubPublicDns();
    const { do_, goto } = await makeHarness();

    await do_.webSocketMessage(ws, renderFallback(LAST_SITE));

    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0][0]).toBe(LAST_SITE);
  });

  it("tells the client where the viewport now is", async () => {
    stubPublicDns();
    const { do_, sent } = await makeHarness();

    await do_.webSocketMessage(ws, renderFallback(LAST_SITE));

    const state = sent.filter((m) => m.type === "state").at(-1);
    expect(state?.origin).toBe(LAST_SITE);
  });
});

describe("render_fallback grants nothing", () => {
  it("does not add the origin to session consent", async () => {
    // The Consent panel renders exactly this list, with a revoke button per
    // entry. An unrelated site appearing there is the reported bug.
    stubPublicDns();
    const { do_ } = await makeHarness();

    await do_.webSocketMessage(ws, renderFallback(LAST_SITE));

    const { consent } = await do_.listConsent();
    expect(consent).toEqual([]);
  });

  it("broadcasts no origin_granted line", async () => {
    // "Opening allbirds.com — granted for this session" is the model-picked
    // wording spec §6 forbids for this path.
    stubPublicDns();
    const { do_, sent } = await makeHarness();

    await do_.webSocketMessage(ws, renderFallback(LAST_SITE));

    expect(sent.filter((m) => m.type === "origin_granted")).toEqual([]);
  });

  it("registers no tools for the origin", async () => {
    // `navigate_to` calls refreshRemoteTools, whose broadcast is what makes
    // the client register the origin's tools. The render-only path must not.
    stubPublicDns();
    const { do_, sent } = await makeHarness();

    await do_.webSocketMessage(ws, renderFallback(LAST_SITE));

    // `sendState` always carries a `remoteTools` field; what matters is that
    // it stays empty, because a non-empty one is what drives the client's
    // `syncTools` for the origin.
    expect(sent.every((m) => ((m.remoteTools as unknown[]) ?? []).length === 0)).toBe(
      true,
    );
    // The client registers a manifest's tools from the `consented` set in
    // `state`, so the origin staying out of that set is what keeps
    // `fill_checkout_on_allbirds_com` off the page.
    for (const msg of sent) {
      if (msg.type !== "state") continue;
      expect(msg.consented).toEqual([]);
    }
  });

  it("leaves the origin out of what a claim writes to the account", async () => {
    stubPublicDns();
    const { do_ } = await makeHarness();
    const claim = vi.fn(async () => ({ grants: [] }));
    const env = (do_ as unknown as { env: { ACCOUNT: unknown } }).env;
    env.ACCOUNT = { getByName: vi.fn(() => ({ claim, grant: vi.fn() })) };

    await do_.webSocketMessage(ws, renderFallback(LAST_SITE));
    await do_.claimAccount("acct_1");

    expect(claim).toHaveBeenCalledWith("t".repeat(64), []);
  });
});

describe("render_fallback keeps every navigation guard", () => {
  it("refuses a cleartext origin", async () => {
    stubPublicDns();
    const { do_, goto } = await makeHarness();

    await do_.webSocketMessage(ws, renderFallback("http://www.allbirds.com"));

    expect(goto).not.toHaveBeenCalled();
  });

  it("refuses a URL carrying credentials", async () => {
    stubPublicDns();
    const { do_, goto } = await makeHarness();

    await do_.webSocketMessage(
      ws,
      renderFallback("https://user:pass@www.allbirds.com/"),
    );

    expect(goto).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to a private address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("type=AAAA")
          ? new Response(JSON.stringify({ Status: 0, Answer: [] }))
          : new Response(
              JSON.stringify({
                Status: 0,
                Answer: [{ type: 1, TTL: 300, data: "127.0.0.1" }],
              }),
            ),
      ),
    );
    const { do_, goto } = await makeHarness();

    await do_.webSocketMessage(ws, renderFallback("https://rebind.example"));

    expect(goto).not.toHaveBeenCalled();
  });

  it("refuses when the hostname does not resolve stably", async () => {
    // navigationStable resolves twice, ~250 ms apart, and aborts if either
    // answer is a private address. Fail-closed, exactly as on the granted
    // path.
    //
    // The flip below used to land on another *public* address, back when the
    // check was set equality. That is a CDN rotating, not an attack, and it
    // is allowed now — so this exercises the rebind that matters: public at
    // guard time, private at fetch time.
    //
    // Three A queries reach the resolver: isPrivateUrl's, then
    // navigationStable's two. The flip lands on the third, which is the
    // rebind the second resolution exists to catch.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("type=AAAA")) {
          return new Response(JSON.stringify({ Status: 0, Answer: [] }));
        }
        call += 1;
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: [
              {
                type: 1,
                TTL: 300,
                data: call < 3 ? "93.184.216.34" : "10.0.0.1",
              },
            ],
          }),
        );
      }),
    );
    const { do_, goto } = await makeHarness();

    await do_.webSocketMessage(ws, renderFallback("https://rebind.example"));

    expect(goto).not.toHaveBeenCalled();
  });

  it("refuses an origin that is not a URL at all", async () => {
    stubPublicDns();
    const { do_, goto } = await makeHarness();

    await do_.webSocketMessage(ws, renderFallback("allbirds.com"));

    expect(goto).not.toHaveBeenCalled();
  });
});

describe("the granted path is unchanged", () => {
  it("navigate_to still auto-grants, as its other callers rely on", async () => {
    // The fix is a second path, not a narrowing of allowOrigin: five other
    // call sites depend on it granting.
    stubPublicDns();
    const { do_ } = await makeHarness();

    const res = await do_.callTool("navigate_to", { origin: LAST_SITE });

    expect(res.ok).toBe(true);
    const { consent } = await do_.listConsent();
    expect(consent).toEqual([LAST_SITE]);
  });
});
