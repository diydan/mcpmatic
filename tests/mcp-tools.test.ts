import { describe, expect, it } from "vitest";
import { buildToolList, SPINE_NAMES } from "../worker/mcp/tools";
import { blessedManifests, type RegistryEntry } from "../worker/manifest-registry";
import type { ToolManifest } from "../../shared/manifest";

describe("MCP tool list", () => {
  it("always includes the three spine tools", async () => {
    const list = await buildToolList(new Set());
    const names = list.map((t) => t.name);
    for (const spine of SPINE_NAMES) {
      expect(names).toContain(spine);
    }
  });

  it("includes a per-origin manifest only when its origin is consented", async () => {
    const list = await buildToolList(new Set(["https://www.allbirds.com"]));
    const names = list.map((t) => t.name);
    expect(names).toContain("search_catalog_on_allbirds_com");
    expect(names).not.toContain("search_flights_on_kayak_com");
  });

  it("does not include any per-origin tool when no origins are consented", async () => {
    const list = await buildToolList(new Set());
    const allbirds = list.find((t) => t.name === "search_catalog_on_allbirds_com");
    expect(allbirds).toBeUndefined();
  });

  it("descriptor shape matches McpToolDescriptor", async () => {
    const list = await buildToolList(new Set(["https://www.allbirds.com"]));
    const t = list.find((x) => x.name === "search_catalog_on_allbirds_com");
    expect(t?.inputSchema.type).toBe("object");
    expect(typeof t?.description).toBe("string");
  });
});

describe("buildToolList with a registry", () => {
  it("includes a blessed generated tool for a consented origin", async () => {
    const generated: ToolManifest = {
      name: "search_widgets_on_example_com",
      description: "search widgets",
      origin: "https://example.com",
      inputSchema: { type: "object", properties: {} },
      steps: [{ action: "goto", url: "https://example.com" }],
    };
    const entry: RegistryEntry = {
      tools: [{ manifest: generated, status: "blessed", generatedAt: 1, blessedAt: 2 }],
    };
    const kv = {
      get: async (key: string) =>
        key === "origin:https://example.com" ? JSON.stringify(entry) : null,
      put: async () => {},
    };
    const list = await buildToolList(new Set(["https://example.com"]), kv);
    expect(list.some((t) => t.name === "search_widgets_on_example_com")).toBe(true);
  });

  it("omits a draft (unblessed) generated tool", async () => {
    const generated: ToolManifest = {
      name: "search_widgets_on_example_com",
      description: "search widgets",
      origin: "https://example.com",
      inputSchema: { type: "object", properties: {} },
      steps: [{ action: "goto", url: "https://example.com" }],
    };
    const entry: RegistryEntry = {
      tools: [{ manifest: generated, status: "draft", generatedAt: 1 }],
    };
    const kv = {
      get: async (key: string) =>
        key === "origin:https://example.com" ? JSON.stringify(entry) : null,
      put: async () => {},
    };
    const list = await buildToolList(new Set(["https://example.com"]), kv);
    expect(list.some((t) => t.name === "search_widgets_on_example_com")).toBe(false);
  });

  it("ignores an unconsented origin's registry entry entirely", async () => {
    const kv = {
      get: async () => {
        throw new Error("must not be called for an unconsented origin");
      },
      put: async () => {},
    };
    const list = await buildToolList(new Set(), kv);
    expect(list.map((t) => t.name)).not.toContain("search_widgets_on_example_com");
  });
});