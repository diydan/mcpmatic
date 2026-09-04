import { describe, expect, it, vi } from "vitest";
import { handlePasskey } from "../worker/passkey-routes";

const ACCOUNT = "a".repeat(64);
const TOKEN = "b".repeat(64);

function makeEnv(accountId: string | null) {
  const kv = new Map<string, string>();
  const accountForPasskey = vi.fn(async () => ({ accountId }));
  const addCredential = vi.fn(async () => ({ ok: true as const }));
  return {
    env: {
      SESSION: { getByName: vi.fn(() => ({ accountForPasskey })) },
      ACCOUNT: { getByName: vi.fn(() => ({ addCredential })) },
      OAUTH_TOKENS: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
        delete: async (k: string) => void kv.delete(k),
      },
    } as unknown as Env,
    accountForPasskey,
    kv,
  };
}

function post(sub: string, body: unknown) {
  return new Request(`https://browsermatic.test/account/passkey/${sub}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("passkey registration is bound to a session the caller holds", () => {
  it("takes the account from the session, not from the request body", async () => {
    // Trusting a body field would let anyone who learns an account id attach
    // their own authenticator to it and keep durable access.
    const { env, accountForPasskey, kv } = makeEnv(ACCOUNT);
    const res = await handlePasskey(
      post("register/options", { sessionToken: TOKEN, accountId: "c".repeat(64) }),
      env,
      "register/options",
    );
    expect(res.status).toBe(200);
    expect(accountForPasskey).toHaveBeenCalled();
    const stored = [...kv.values()].map((v) => JSON.parse(v) as { accountId?: string });
    expect(stored[0]?.accountId).toBe(ACCOUNT);
  });

  it("refuses when the session has not been claimed by an account", async () => {
    const { env } = makeEnv(null);
    const res = await handlePasskey(
      post("register/options", { sessionToken: TOKEN }),
      env,
      "register/options",
    );
    expect(res.status).toBe(400);
  });

  it("refuses a request with no session token at all", async () => {
    const { env, accountForPasskey } = makeEnv(ACCOUNT);
    const res = await handlePasskey(
      post("register/options", { accountId: ACCOUNT }),
      env,
      "register/options",
    );
    expect(res.status).toBe(400);
    expect(accountForPasskey).not.toHaveBeenCalled();
  });

  it("refuses a malformed session token without consulting the session", async () => {
    const { env, accountForPasskey } = makeEnv(ACCOUNT);
    const res = await handlePasskey(
      post("register/options", { sessionToken: "nope" }),
      env,
      "register/options",
    );
    expect(res.status).toBe(400);
    expect(accountForPasskey).not.toHaveBeenCalled();
  });
});
