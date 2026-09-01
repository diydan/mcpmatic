import { describe, expect, it, beforeEach } from "vitest";
import { OAuthCodeDO } from "../worker/oauth/code-do";
import type { AuthCode } from "../worker/oauth/types";

/**
 * The DO's constructor calls `state.blockConcurrencyWhile(...)` to hydrate the
 * cached code from storage, and the fetch handler reads/writes `state.storage`.
 * Both surfaces are mocked here with an in-memory implementation. The DO is
 * instantiated with `new OAuthCodeDO(state)` because the brief uses the
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

function codeFixture(overrides: Partial<AuthCode> = {}): AuthCode {
  return {
    code: "auth-code-1",
    clientId: "client-abc",
    userSessionToken: "a".repeat(64),
    redirectUri: "https://example.com/callback",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    codeChallengeMethod: "S256",
    // 10 minutes from now — well within the brief's lifetime.
    expiresAt: Date.now() + 10 * 60 * 1000,
    used: false,
    ...overrides,
  };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://do.local${path}`, init);
}

describe("OAuthCodeDO", () => {
  let ctx: ReturnType<typeof makeFakeState>;
  let do_: OAuthCodeDO;

  beforeEach(() => {
    ctx = makeFakeState();
    do_ = new OAuthCodeDO(ctx.state);
  });

  it("POST /issue stores the code and returns the code string", async () => {
    const c = codeFixture({ code: "new-code-xyz" });
    const res = await do_.fetch(
      req("/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(c),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "new-code-xyz" });
    // Persisted to storage so a cold start on a new instance finds it.
    expect(ctx.data["code"]).toEqual(c);
  });

  it("POST /consume returns the code once, then 400 invalid_grant on replay", async () => {
    const c = codeFixture({ code: "replay-target" });
    await do_.fetch(
      req("/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(c),
      }),
    );

    // First consume: succeeds and returns the full AuthCode with used=true.
    const first = await do_.fetch(req("/consume", { method: "POST" }));
    expect(first.status).toBe(200);
    const consumed = await first.json();
    expect(consumed.code).toBe("replay-target");
    expect(consumed.used).toBe(true);

    // Second consume: same code, must be rejected with invalid_grant.
    const second = await do_.fetch(req("/consume", { method: "POST" }));
    expect(second.status).toBe(400);
    expect(await second.text()).toBe("invalid_grant");

    // The persisted copy is also marked used, so a cold start cannot revive it.
    expect((ctx.data["code"] as AuthCode).used).toBe(true);
  });

  it("POST /consume returns 400 invalid_grant when expiresAt has passed", async () => {
    // Already-expired code: 1ms in the past.
    const c = codeFixture({ code: "stale-code", expiresAt: Date.now() - 1 });
    await do_.fetch(
      req("/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(c),
      }),
    );

    const res = await do_.fetch(req("/consume", { method: "POST" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid_grant");

    // Expiry rejection must NOT mutate the stored code: still unused so the
    // operator can diagnose via /issue storage without a poisoned used flag.
    expect((ctx.data["code"] as AuthCode).used).toBe(false);
  });

  it("POST /consume returns 400 invalid_grant when no code has been issued", async () => {
    // Fresh DO — no /issue call — and the cold start found no stored code.
    const res = await do_.fetch(req("/consume", { method: "POST" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid_grant");
  });

  it("unknown paths return 404", async () => {
    const res = await do_.fetch(req("/nope"));
    expect(res.status).toBe(404);
  });

  it("constructor hydrates from storage on cold start", async () => {
    const c = codeFixture({ code: "hydrated-code" });
    const warmCtx = makeFakeState({ code: c });
    const warmDo = new OAuthCodeDO(warmCtx.state);
    // The real DO runtime blocks incoming fetches until blockConcurrencyWhile
    // settles; the fake exposes the same promise so the test can wait for it.
    await warmCtx.awaitHydration();

    const consume = await warmDo.fetch(req("/consume", { method: "POST" }));
    expect(consume.status).toBe(200);
    expect((await consume.json()).code).toBe("hydrated-code");

    // Replay still rejected after hydration.
    const replay = await warmDo.fetch(req("/consume", { method: "POST" }));
    expect(replay.status).toBe(400);
    expect(await replay.text()).toBe("invalid_grant");
  });
});