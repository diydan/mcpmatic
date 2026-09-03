import { describe, expect, it } from "vitest";
import { ensureAccountId } from "../src/lib/account-store";
import { isAccountId } from "../worker/account";

function fakeStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

describe("ensureAccountId", () => {
  it("generates a well-formed id when there is none", () => {
    const store = fakeStorage();
    const id = ensureAccountId(store);
    expect(isAccountId(id)).toBe(true);
  });

  it("persists the id it generated", () => {
    const store = fakeStorage();
    const id = ensureAccountId(store);
    expect(ensureAccountId(store)).toBe(id);
  });

  it("keeps an id that is already stored", () => {
    const existing = "a".repeat(64);
    const store = fakeStorage({ "mcpmatic.accountId": existing });
    expect(ensureAccountId(store)).toBe(existing);
  });

  it("replaces a malformed stored id rather than sending it to the worker", () => {
    // The worker rejects a bad shape with a 400. Regenerating here means a
    // corrupted value costs the grants once, not on every load forever.
    const store = fakeStorage({ "mcpmatic.accountId": "corrupted" });
    const id = ensureAccountId(store);
    expect(isAccountId(id)).toBe(true);
    expect(id).not.toBe("corrupted");
  });

  it("returns null when storage is unavailable rather than throwing", () => {
    // Private browsing, blocked site data. No account is a working session.
    const id = ensureAccountId({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    });
    expect(id).toBeNull();
  });
});
