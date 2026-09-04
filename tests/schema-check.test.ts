import { describe, expect, it } from "vitest";
import { checkArgs } from "../worker/schema-check";

const schema = {
  type: "object",
  properties: {
    variantId: { type: "string" },
    quantity: { type: "number" },
  },
  required: ["variantId", "quantity"],
  additionalProperties: false,
};

describe("checkArgs", () => {
  it("passes arguments that satisfy the tool's own schema", () => {
    expect(checkArgs(schema, { variantId: "v1", quantity: 2 })).toEqual({
      ok: true,
    });
  });

  it("names a required property the caller did not send", () => {
    // The merchant-facing sentence: "your schema requires a field your own
    // storefront never sends."
    expect(checkArgs(schema, { variantId: "v1" })).toEqual({
      ok: false,
      missing: ["quantity"],
      wrongType: [],
      unexpected: [],
    });
  });

  it("names a property sent with the wrong type", () => {
    const out = checkArgs(schema, { variantId: "v1", quantity: "2" });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.wrongType).toEqual(["quantity"]);
  });

  it("names a property the schema does not allow", () => {
    const out = checkArgs(schema, { variantId: "v", quantity: 1, colour: "red" });
    expect(out.ok === false && out.unexpected).toEqual(["colour"]);
  });

  it("allows extra properties when the schema does not forbid them", () => {
    const open = { type: "object", properties: {}, required: [] };
    expect(checkArgs(open, { anything: 1 })).toEqual({ ok: true });
  });

  it("passes when there is no usable schema to judge against", () => {
    // Never invent a failure. An unreadable schema means we do not know, and
    // "we do not know" must not be reported to a merchant as their bug.
    expect(checkArgs(undefined, { a: 1 })).toEqual({ ok: true });
    expect(checkArgs({ type: "string" }, { a: 1 })).toEqual({ ok: true });
  });

  it("accepts null for a nullable declared type rather than calling it wrong", () => {
    const nullable = {
      type: "object",
      properties: { note: { type: ["string", "null"] } },
    };
    expect(checkArgs(nullable, { note: null })).toEqual({ ok: true });
  });

  it("treats an integer as satisfying number", () => {
    expect(checkArgs(schema, { variantId: "v", quantity: 3 })).toEqual({ ok: true });
  });
});
