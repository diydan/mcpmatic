import { describe, expect, it } from "vitest";
import { summarise } from "../worker/site-summary";

const rows = [
  { tool: "update_cart", ok: 0, reason: "schema-mismatch", ms: 100, ts: 5 },
  { tool: "update_cart", ok: 0, reason: "schema-mismatch", ms: 200, ts: 4 },
  { tool: "update_cart", ok: 1, reason: null, ms: 300, ts: 3 },
  { tool: "search_catalog", ok: 1, reason: null, ms: 50, ts: 2 },
];

describe("summarise", () => {
  it("counts calls per tool", () => {
    const out = summarise(rows);
    expect(out.find((t) => t.tool === "update_cart")?.calls).toBe(3);
    expect(out.find((t) => t.tool === "search_catalog")?.calls).toBe(1);
  });

  it("splits ok from failed", () => {
    const cart = summarise(rows).find((t) => t.tool === "update_cart")!;
    expect(cart.ok).toBe(1);
    expect(cart.failed).toBe(2);
  });

  it("counts each failure reason", () => {
    const cart = summarise(rows).find((t) => t.tool === "update_cart")!;
    expect(cart.reasons).toEqual({ "schema-mismatch": 2 });
  });

  it("reports the median duration, not the mean", () => {
    // One 30-second timeout must not make a fast tool look slow.
    const cart = summarise(rows).find((t) => t.tool === "update_cart")!;
    expect(cart.p50ms).toBe(200);
  });

  it("orders the busiest tool first", () => {
    expect(summarise(rows)[0].tool).toBe("update_cart");
  });

  it("returns nothing for no rows rather than a zeroed row", () => {
    expect(summarise([])).toEqual([]);
  });

  it("carries no field names, values, or per-caller identity", () => {
    const json = JSON.stringify(summarise(rows));
    for (const leak of ["address", "postcode", "session", "account", "userHandle"]) {
      expect(json).not.toContain(leak);
    }
  });
});
