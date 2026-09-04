import { describe, expect, it, vi } from "vitest";
import { putChallenge, takeChallenge } from "../worker/passkey-challenge";

function fakeKv() {
  const map = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => map.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, _o?: unknown) => void map.set(k, v)),
    delete: vi.fn(async (k: string) => void map.delete(k)),
    map,
  };
}

describe("passkey challenges", () => {
  it("returns what was stored", async () => {
    const kv = fakeKv();
    await putChallenge(kv, "chal-1", { kind: "login" });
    expect(await takeChallenge(kv, "chal-1")).toEqual({ kind: "login" });
  });

  it("is single use", async () => {
    // A replayed challenge is a replayed ceremony. Taking it must consume it.
    const kv = fakeKv();
    await putChallenge(kv, "chal-1", { kind: "login" });
    await takeChallenge(kv, "chal-1");
    expect(await takeChallenge(kv, "chal-1")).toBeNull();
  });

  it("returns null for a challenge that was never issued", async () => {
    expect(await takeChallenge(fakeKv(), "never")).toBeNull();
  });

  it("expires on its own, so an abandoned ceremony cannot be resumed later", async () => {
    const kv = fakeKv();
    await putChallenge(kv, "chal-1", { kind: "login" });
    expect(kv.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
  });

  it("keeps the account a registration was issued for", async () => {
    const kv = fakeKv();
    const accountId = "a".repeat(64);
    await putChallenge(kv, "chal-2", { kind: "register", accountId });
    expect(await takeChallenge(kv, "chal-2")).toEqual({
      kind: "register",
      accountId,
    });
  });

  it("treats an unreadable record as absent rather than throwing", async () => {
    const kv = fakeKv();
    kv.map.set("webauthn:chal-3", "not json");
    expect(await takeChallenge(kv, "chal-3")).toBeNull();
  });
});
