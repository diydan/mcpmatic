import { describe, expect, it } from "vitest";
import { claimDecision, isAccountId } from "../worker/account";

describe("claimDecision", () => {
  it("lets an unclaimed session join an account", () => {
    expect(claimDecision(null, "acct_1")).toEqual({ ok: true });
  });

  it("is idempotent for the account that already holds it", () => {
    // A console reload re-claims. Failing there would strand a working
    // session for no reason.
    expect(claimDecision("acct_1", "acct_1")).toEqual({ ok: true });
  });

  it("refuses a session already claimed by someone else", () => {
    // The capability token is a bearer credential; whoever holds it could try
    // to bind it to their own account and inherit the grants. First claim wins.
    expect(claimDecision("acct_1", "acct_2")).toEqual({
      ok: false,
      reason: "claimed-by-another",
    });
  });

  it("refuses an empty incoming account id", () => {
    expect(claimDecision(null, "")).toEqual({ ok: false, reason: "no-account" });
  });
});

describe("isAccountId", () => {
  const good = "a".repeat(64);

  it("accepts 64 hex characters", () => {
    expect(isAccountId(good)).toBe(true);
    expect(isAccountId("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("rejects anything shorter or longer", () => {
    expect(isAccountId("a".repeat(63))).toBe(false);
    expect(isAccountId("a".repeat(65))).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isAccountId("g".repeat(64))).toBe(false);
    expect(isAccountId(`${"a".repeat(63)}/`)).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isAccountId(undefined)).toBe(false);
    expect(isAccountId(123)).toBe(false);
  });

  it("accepts upper case, since a DO name is compared verbatim", () => {
    // Callers must not normalise: "AAA…" and "aaa…" would otherwise be two
    // different accounts that both validate.
    expect(isAccountId("A".repeat(64))).toBe(true);
  });
});
