import { describe, expect, it } from "vitest";
import { buildToolList, SPINE_NAMES } from "../worker/mcp/tools";

describe("MCP tool list", () => {
  it("always includes the three spine tools", () => {
    const list = buildToolList(new Set());
    const names = list.map((t) => t.name);
    for (const spine of SPINE_NAMES) {
      expect(names).toContain(spine);
    }
  });

  it("includes a per-origin manifest only when its origin is consented", () => {
    const list = buildToolList(new Set(["https://www.allbirds.com"]));
    const names = list.map((t) => t.name);
    expect(names).toContain("search_catalog_on_allbirds_com");
    expect(names).not.toContain("search_flights_on_kayak_com");
  });

  it("does not include any per-origin tool when no origins are consented", () => {
    const list = buildToolList(new Set());
    const allbirds = list.find((t) => t.name === "search_catalog_on_allbirds_com");
    expect(allbirds).toBeUndefined();
  });

  it("descriptor shape matches McpToolDescriptor", () => {
    const list = buildToolList(new Set(["https://www.allbirds.com"]));
    const t = list.find((x) => x.name === "search_catalog_on_allbirds_com");
    expect(t?.inputSchema.type).toBe("object");
    expect(typeof t?.description).toBe("string");
  });
});