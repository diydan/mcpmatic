import { describe, expect, it } from "vitest";
import { buildToolList, SPINE_NAMES } from "../worker/mcp/tools";
import type { RegistryEntry } from "../worker/manifest-registry";
import type { ToolManifest } from "../shared/manifest";

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

  it("does not duplicate a tool name that exists both statically and in the registry", async () => {
    const generated: ToolManifest = {
      name: "search_flights_on_kayak_com",
      description: "duplicate",
      origin: "https://www.kayak.com",
      inputSchema: { type: "object", properties: {} },
      steps: [{ action: "goto", url: "https://www.kayak.com" }],
    };
    const entry: RegistryEntry = {
      tools: [{ manifest: generated, status: "blessed", generatedAt: 1, blessedAt: 2 }],
    };
    const kv = {
      get: async (key: string) =>
        key === "origin:https://www.kayak.com" ? JSON.stringify(entry) : null,
      put: async () => {},
    };
    const list = await buildToolList(new Set(["https://www.kayak.com"]), kv);
    const matches = list.filter((t) => t.name === "search_flights_on_kayak_com");
    expect(matches).toHaveLength(1);
  });

  it("ignores a registry entry whose manifest.origin doesn't match the key it was read from", async () => {
    const mismatched: ToolManifest = {
      name: "search_widgets_on_example_com",
      description: "mis-keyed",
      origin: "https://attacker.example.com",
      inputSchema: { type: "object", properties: {} },
      steps: [{ action: "goto", url: "https://attacker.example.com" }],
    };
    const entry: RegistryEntry = {
      tools: [{ manifest: mismatched, status: "blessed", generatedAt: 1, blessedAt: 2 }],
    };
    const kv = {
      get: async (key: string) =>
        key === "origin:https://example.com" ? JSON.stringify(entry) : null,
      put: async () => {},
    };
    const list = await buildToolList(new Set(["https://example.com"]), kv);
    expect(list.some((t) => t.name === "search_widgets_on_example_com")).toBe(false);
  });
});
describe("approval-required tools are labelled", () => {
  const APPROVAL_NOTE = "Requires human approval in the BrowserMatic console.";

  it("marks a tool that declares fillsFrom", async () => {
    const list = await buildToolList(new Set(["https://www.allbirds.com"]));
    const fill = list.find((t) => t.name === "fill_checkout_on_allbirds_com");
    expect(fill?.description).toContain(APPROVAL_NOTE);
  });

  it("leaves a tool without fillsFrom alone", async () => {
    const list = await buildToolList(new Set(["https://www.allbirds.com"]));
    const search = list.find((t) => t.name === "search_catalog_on_allbirds_com");
    expect(search?.description).not.toContain(APPROVAL_NOTE);
  });
});

describe("check_approval is on the surface", () => {
  it("is a spine tool, so a pending approval can be collected", async () => {
    // requestBounded hands back an id rather than holding the caller open.
    // Without a tool to redeem it, that id is useless.
    const list = await buildToolList(new Set());
    const check = list.find((t) => t.name === "check_approval");
    expect(check).toBeDefined();
    expect(check?.inputSchema.required).toEqual(["id"]);
  });

  it("is always present, like the rest of the spine", async () => {
    expect(SPINE_NAMES).toContain("check_approval");
  });
});
