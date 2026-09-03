/**
 * @vitest-environment node
 *
 * checkArgs against schemas captured from the live allbirds.com storefront
 * (tests/fixtures/allbirds-webmcp-schemas.json, read via list_remote_tools on
 * a deployed Worker).
 *
 * The invented fixtures in schema-check.test.ts are flat. Shopify's are not:
 * update_cart declares required:["cart"] at the top and the field that matters,
 * line_items, one level down. A checker that only reads the top level passes
 * {cart:{}} straight through — and the call it lets past is exactly the one the
 * telemetry pitch is built on.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkArgs } from "../worker/schema-check";

const schemas = JSON.parse(
  readFileSync("tests/fixtures/allbirds-webmcp-schemas.json", "utf8"),
) as Record<string, unknown>;

describe("checkArgs against live Shopify schemas", () => {
  it("catches a nested required field, not just a top-level one", () => {
    const out = checkArgs(schemas.update_cart, { cart: {} });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.missing).toContain("cart.line_items");
  });

  it("still catches the top-level requirement", () => {
    const out = checkArgs(schemas.update_cart, {});
    expect(out.ok === false && out.missing).toEqual(["cart"]);
  });

  it("passes a call that satisfies the nested shape", () => {
    expect(
      checkArgs(schemas.update_cart, {
        cart: { line_items: [{ handle: "wool-runner" }] },
      }),
    ).toEqual({ ok: true });
  });

  it("catches search_catalog's nested query requirement", () => {
    const out = checkArgs(schemas.search_catalog, { catalog: {} });
    expect(out.ok === false && out.missing).toContain("catalog.query");
  });

  it("passes a well-formed search", () => {
    expect(
      checkArgs(schemas.search_catalog, { catalog: { query: "wool runner" } }),
    ).toEqual({ ok: true });
  });

  it("reports a nested field sent with the wrong type", () => {
    const out = checkArgs(schemas.search_catalog, { catalog: { query: 7 } });
    expect(out.ok === false && out.wrongType).toContain("catalog.query");
  });

  it("does not invent failures for any real schema called with nothing", () => {
    // A tool with no required fields must not be reported as mismatched just
    // because the caller sent an empty object.
    for (const [name, schema] of Object.entries(schemas)) {
      const required = (schema as { required?: string[] }).required ?? [];
      if (required.length) continue;
      expect(checkArgs(schema, {}), `${name} should accept {}`).toEqual({ ok: true });
    }
  });
});
