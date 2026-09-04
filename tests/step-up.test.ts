/**
 * Tests for the step-up token table on `OAUTH_TOKENS`.
 *
 * The token is what binds a fresh WebAuthn assertion to a specific
 * {accountId, sessionToken} pair, so the assertion cannot be lifted onto
 * another session or another account. These tests exercise the KV-backed
 * lifecycle directly: mint writes, take reads-and-deletes, and both legs
 * refuse mismatched fields so cross-account or cross-session replay is a
 * null record rather than a partial match.
 */
import { describe, expect, it, vi } from "vitest";
import { mintStepUp, takeStepUp } from "../worker/passkey-challenge";

function fakeKv() {
  const map = new Map<string, string>();
  const calls = { put: 0 };
  return {
    get: vi.fn(async (k: string) => map.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, _o?: unknown) => {
      calls.put++;
      map.set(k, v);
    }),
    delete: vi.fn(async (k: string) => void map.delete(k)),
    map,
    calls,
  };
}

const ACCOUNT = "a".repeat(64);
const SESSION = "b".repeat(64);

describe("step-up token", () => {
  it("returns what was stored when the consumer matches the binding", async () => {
    const kv = fakeKv();
    await mintStepUp(kv, "step-1", {
      accountId: ACCOUNT,
      sessionToken: SESSION,
    });
    const taken = await takeStepUp(kv, "step-1", {
      accountId: ACCOUNT,
      sessionToken: SESSION,
    });
    expect(taken).toEqual({ accountId: ACCOUNT, sessionToken: SESSION });
  });

  it("is single use", async () => {
    // A replayed token would let the same assertion claim a second account
    // or survive a rotation; taking must consume it.
    const kv = fakeKv();
    await mintStepUp(kv, "step-1", {
      accountId: ACCOUNT,
      sessionToken: SESSION,
    });
    const first = await takeStepUp(kv, "step-1", {
      accountId: ACCOUNT,
      sessionToken: SESSION,
    });
    const second = await takeStepUp(kv, "step-1", {
      accountId: ACCOUNT,
      sessionToken: SESSION,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("rejects a token whose sessionToken does not match", async () => {
    const kv = fakeKv();
    await mintStepUp(kv, "step-1", {
      accountId: ACCOUNT,
      sessionToken: SESSION,
    });
    const taken = await takeStepUp(kv, "step-1", {
      accountId: ACCOUNT,
      sessionToken: "c".repeat(64),
    });
    expect(taken).toBeNull();
    // The mismatch must not consume the record: the rightful holder still
    // gets to claim it. Otherwise an attacker who races the consumer with
    // a wrong sessionToken can lock the real one out.
    expect(kv.map.size).toBe(1);
  });

  it("rejects a token whose accountId does not match", async () => {
    const kv = fakeKv();
    await mintStepUp(kv, "step-1", {
      accountId: ACCOUNT,
      sessionToken: SESSION,
    });
    const taken = await takeStepUp(kv, "step-1", {
      accountId: "d".repeat(64),
      sessionToken: SESSION,
    });
    expect(taken).toBeNull();
    expect(kv.map.size).toBe(1);
  });

  it("returns null for a token that was never minted", async () => {
    expect(
      await takeStepUp(fakeKv(), "never", {
        accountId: ACCOUNT,
        sessionToken: SESSION,
      }),
    ).toBeNull();
  });

  it("writes with a 5-minute TTL so an abandoned ceremony cannot be resumed later", async () => {
    const kv = fakeKv();
    await mintStepUp(kv, "step-1", {
      accountId: ACCOUNT,
      sessionToken: SESSION,
    });
    expect(kv.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 300 }),
    );
  });

  it("refuses to consume a record with a missing or mismatched kind discriminator", async () => {
    const kv = fakeKv();
    // Hand-craft a record that has the right fields but no `kind: "stepup"`
    // discriminator. Without the kind, a stray record under the stepup:*
    // namespace from any other source could be consumed as if it were a
    // step-up token. takeStepUp must reject it.
    kv.map.set(
      "stepup:step-1",
      JSON.stringify({ accountId: ACCOUNT, sessionToken: SESSION }),
    );
    const taken = await takeStepUp(kv, "step-1", {
      accountId: ACCOUNT,
      sessionToken: SESSION,
    });
    expect(taken).toBeNull();
  });

  it("treats an unreadable record as absent rather than throwing", async () => {
    const kv = fakeKv();
    kv.map.set("stepup:step-1", "not json");
    expect(
      await takeStepUp(kv, "step-1", {
        accountId: ACCOUNT,
        sessionToken: SESSION,
      }),
    ).toBeNull();
  });
});