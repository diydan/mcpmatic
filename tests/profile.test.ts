/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import {
  SEED_PROFILE,
  hasWholeObjectGetter,
  resolveFields,
} from "../shared/profile";
import { profileStore } from "../src/lib/profile-store";
import { AUDIT_DDL } from "../shared/protocol";

describe("profile resolver", () => {
  it("resolves only the declared path and no sibling", () => {
    const got = resolveFields(SEED_PROFILE, ["address.postcode"]);
    expect(got).toEqual({ "address.postcode": "EC2A 3DZ" });
    expect(got["address.line1"]).toBeUndefined();
    expect(Object.keys(got)).toEqual(["address.postcode"]);
  });

  it("exposes no whole-object getter on the store", () => {
    expect(hasWholeObjectGetter(profileStore)).toBe(false);
    expect("getProfile" in profileStore).toBe(false);
  });
});

describe("audit schema", () => {
  it("has no column that could hold argument values", () => {
    expect(AUDIT_DDL).toMatch(/field_names/);
    expect(AUDIT_DDL.toLowerCase()).not.toMatch(/value/);
    expect(AUDIT_DDL.toLowerCase()).not.toMatch(/arguments/);
    expect(AUDIT_DDL.toLowerCase()).not.toMatch(/payload/);
  });
});
