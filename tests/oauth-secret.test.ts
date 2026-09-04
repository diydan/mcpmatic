/**
 * Tests for `worker/oauth/secret.ts` — the salted SHA-256 hashing and
 * constant-time verification primitives for OAuth `client_secret`.
 *
 * Per the 2026-09-04 review (DSRV-L1, DSRV-L2): the previous design stored
 * `client_secret` in plaintext on `OAuthClientDO` and compared it with
 * `!==`. We now hash on persist (the `clientId` is the per-client salt;
 * it's already unique and is recorded alongside the hash on registration)
 * and verify with a constant-time compare on `sha256:<hex>` strings.
 *
 * NOTE on the salt argument: the brief originally specified single-arg
 * `hashSecret(plain)` / two-arg `verifySecret(plain, hash)`, but the
 * production call sites in `worker/oauth/register.ts` and
 * `worker/oauth/token.ts` correctly pass `salt = clientId`. These tests
 * match the production API (T6-1 preflight ruling) — `hashSecret` takes
 * `(plain, salt)`, `verifySecret` takes `(plain, stored, salt)`.
 */
import { describe, expect, it } from "vitest";
import { hashSecret, verifySecret } from "../worker/oauth/secret";

describe("client_secret hashing (salted SHA-256)", () => {
  it("verifies a matching secret", async () => {
    const h = await hashSecret("hunter2", "salt");
    expect(await verifySecret("hunter2", h, "salt")).toBe(true);
  });

  it("rejects a wrong secret", async () => {
    const h = await hashSecret("hunter2", "salt");
    expect(await verifySecret("hunter3", h, "salt")).toBe(false);
  });

  it("rejects an empty secret", async () => {
    expect(await verifySecret("", await hashSecret("hunter2", "salt"), "salt")).toBe(
      false,
    );
  });

  it("produces a stable, prefixed hash", async () => {
    const h1 = await hashSecret("hunter2", "salt");
    const h2 = await hashSecret("hunter2", "salt");
    expect(h1).toBe(h2);
    expect(h1.startsWith("sha256:")).toBe(true);
    // "sha256:" is 7 chars; SHA-256 hex is 64 chars.
    expect(h1.length).toBe(7 + 64);
  });
});
