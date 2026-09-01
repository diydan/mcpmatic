import { describe, expect, it, beforeEach } from "vitest";
import { OAuthClientDO } from "../worker/oauth/client-do";
import type { OAuthClient } from "../worker/oauth/types";

/**
 * The DO's constructor calls `state.blockConcurrencyWhile(...)` to hydrate the
 * cached client from storage, and the fetch handler reads/writes `state.storage`.
 * Both surfaces are mocked here with an in-memory implementation. The DO is
 * instantiated with `new OAuthClientDO(state)` because the brief uses the
 * `implements DurableObject` pattern (no `env` / RPC stub needed).
 *
 * `blockConcurrencyWhile` returns the callback's promise; the constructor does
 * not await it, so callers that need the DO to be fully hydrated (e.g. tests
 * covering the cold-start path) should `await ctx.awaitHydration()` before
 * invoking `fetch`. This mirrors the runtime guarantee that incoming fetches
 * are queued until the constructor's hydration callback settles.
 */
type FakeStorage = {
  get: <T>(key: string) => Promise<T | undefined>;
  put: <T>(key: string, value: T) => Promise<void>;
  deleteAll: () => Promise<void>;
};

function makeFakeStorage(initial: Record<string, unknown> = {}): {
  storage: FakeStorage;
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = { ...initial };
  const storage: FakeStorage = {
    get: async <T>(key: string) => data[key] as T | undefined,
    put: async <T>(key: string, value: T) => {
      data[key] = value;
    },
    deleteAll: async () => {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
  return { storage, data };
}

function makeFakeState(initial: Record<string, unknown> = {}) {
  const { storage, data } = makeFakeStorage(initial);
  let hydration: Promise<unknown> = Promise.resolve();
  const state = {
    storage,
    blockConcurrencyWhile: <T>(cb: () => Promise<T>): Promise<T> => {
      hydration = cb();
      return hydration as Promise<T>;
    },
  } as unknown as DurableObjectState & {
    /* exposed for tests that construct a DO against pre-seeded storage */
  };
  return {
    state: state as unknown as DurableObjectState,
    data,
    awaitHydration: () => hydration,
  };
}

function clientFixture(overrides: Partial<OAuthClient> = {}): OAuthClient {
  return {
    clientId: "client-abc",
    clientSecret: "secret-xyz",
    redirectUris: ["https://example.com/callback"],
    clientName: "test client",
    createdAt: 1700000000000,
    ...overrides,
  };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://do.local${path}`, init);
}

describe("OAuthClientDO", () => {
  let ctx: ReturnType<typeof makeFakeState>;
  let do_: OAuthClientDO;

  beforeEach(() => {
    ctx = makeFakeState();
    do_ = new OAuthClientDO(ctx.state);
  });

  it("GET /get returns 404 when no client is stored", async () => {
    const res = await do_.fetch(req("/get"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("POST /register stores the client and returns it as JSON", async () => {
    const c = clientFixture();
    const res = await do_.fetch(
      req("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(c),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(c);
    // Persisted to storage so a cold start on a new instance finds it.
    expect(ctx.data["client"]).toEqual(c);
  });

  it("register is idempotent — second call overwrites the first", async () => {
    const first = clientFixture({ clientId: "v1", clientSecret: "s1" });
    const second = clientFixture({
      clientId: "v2",
      clientSecret: "s2",
      createdAt: 1800000000000,
    });

    let res = await do_.fetch(
      req("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(first),
      }),
    );
    expect(await res.json()).toEqual(first);

    res = await do_.fetch(
      req("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(second),
      }),
    );
    expect(await res.json()).toEqual(second);

    // The latest register is what GET /get returns.
    const getRes = await do_.fetch(req("/get"));
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(second);
  });

  it("GET /get returns the stored client after register", async () => {
    const c = clientFixture();
    await do_.fetch(
      req("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(c),
      }),
    );
    const res = await do_.fetch(req("/get"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(c);
  });

  it("POST /revoke returns 204, deletes storage, and a follow-up GET 404s", async () => {
    const c = clientFixture();
    await do_.fetch(
      req("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(c),
      }),
    );
    expect(ctx.data["client"]).toEqual(c);

    const revoke = await do_.fetch(req("/revoke", { method: "POST" }));
    expect(revoke.status).toBe(204);
    expect(revoke.body).toBeNull();
    // Storage is empty afterwards so a future cold start finds nothing.
    expect(ctx.data["client"]).toBeUndefined();

    const getAfter = await do_.fetch(req("/get"));
    expect(getAfter.status).toBe(404);
  });

  it("unknown paths return 404", async () => {
    const res = await do_.fetch(req("/nope"));
    expect(res.status).toBe(404);
  });

  it("constructor hydrates from storage on cold start", async () => {
    const c = clientFixture({ clientId: "hydrated" });
    const warmCtx = makeFakeState({ client: c });
    const warmDo = new OAuthClientDO(warmCtx.state);
    // The real DO runtime blocks incoming fetches until blockConcurrencyWhile
    // settles; the fake exposes the same promise so the test can wait for it.
    await warmCtx.awaitHydration();
    const res = await warmDo.fetch(req("/get"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(c);
  });
});
