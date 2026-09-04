import { describe, expect, it, beforeEach } from "vitest";
import { consume } from "../worker/rate-limit";

// Map-backed stub. `expirationTtl` is irrelevant to the primitive — KV
// garbage-collects expired entries on its own, so the stub just round-trips
// what the primitive wrote.
function makeKv(): {
  kv: KVNamespace;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string, type: "text" | "json" | "arrayBuffer") => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (type === "json") return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function makeEnv(): { env: Env; store: Map<string, string> } {
  const { kv, store } = makeKv();
  return {
    env: { OAUTH_TOKENS: kv } as unknown as Env,
    store,
  };
}

describe("rate-limit", () => {
  let env: Env;
  let store: Map<string, string>;

  beforeEach(() => {
    ({ env, store } = makeEnv());
  });

  it("allows up to N within the window", async () => {
    let allOk = true;
    for (let i = 0; i < 5; i++) {
      const r = await consume(env, "k", "1.2.3.4", { limit: 5, windowSeconds: 60 });
      allOk = allOk && r.ok;
    }
    expect(allOk).toBe(true);
  });

  it("denies the (N+1)th call within the window", async () => {
    for (let i = 0; i < 5; i++) {
      await consume(env, "k", "1.2.3.4", { limit: 5, windowSeconds: 60 });
    }
    const r = await consume(env, "k", "1.2.3.4", { limit: 5, windowSeconds: 60 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window expires", async () => {
    // Seed an EXPIRED bucket — the primitive should treat this as a fresh
    // window and allow the call, since the record's `expiresAt` is in the
    // past. This is what KV does on its own once the TTL elapses.
    const expired = {
      count: 5,
      expiresAt: Date.now() - 1,
    };
    store.set("rl:k:1.2.3.4", JSON.stringify(expired));

    const r = await consume(env, "k", "1.2.3.4", { limit: 5, windowSeconds: 60 });
    expect(r.ok).toBe(true);
  });
});
