import { describe, expect, it } from "vitest";
import { verifyPkce } from "../worker/oauth/pkce";

describe("PKCE (RFC 7636) verification", () => {
  // RFC 7636 §4.6 known-answer test vector.
  it("accepts the RFC 7636 §4.6 known-answer vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await verifyPkce(verifier, challenge)).toBe(true);
  });

  it("rejects a verifier that does not hash to the stored challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const wrongChallenge = "WRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWR";
    expect(await verifyPkce(verifier, wrongChallenge)).toBe(false);
  });

  it("rejects when the stored challenge is empty/missing", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await verifyPkce(verifier, "")).toBe(false);
  });

  it("rejects a verifier that is too short", async () => {
    // 42 chars — RFC 7636 minimum is 43.
    const tooShort = "a".repeat(42);
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await verifyPkce(tooShort, challenge)).toBe(false);
  });

  it("rejects a verifier that is too long", async () => {
    // 129 chars — RFC 7636 maximum is 128.
    const tooLong = "a".repeat(129);
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await verifyPkce(tooLong, challenge)).toBe(false);
  });

  it("rejects a verifier with characters outside the allowed set", async () => {
    // Contains '+' and '/' which are NOT in RFC 7636 §4.1.
    const malformed = "dBjftJeZ4CVP+mB92K27uhbUJU1p1r/wW1gFWFOEjXk!";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await verifyPkce(malformed, challenge)).toBe(false);
  });
});
