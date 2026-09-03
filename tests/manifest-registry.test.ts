import { describe, expect, it, vi } from "vitest";
import {
  getRegistryEntry,
  blessedManifests,
  getBlessedManifestByName,
  recordDraftTools,
  blessTool,
  declineTool,
  type RegistryEntry,
  type KvLike,
} from "../worker/manifest-registry";
import type { ToolManifest } from "../shared/manifest";

const TOOL: ToolManifest = {
  name: "search_widgets_on_example_com",
  description: "search widgets",
  origin: "https://example.com",
  inputSchema: { type: "object", properties: {} },
  steps: [{ action: "goto", url: "https://example.com" }],
};

function fakeKv(store: Record<string, string>): KvLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async () => {}),
  };
}

describe("getRegistryEntry", () => {
  it("returns null when the origin has no entry", async () => {
    const kv = fakeKv({});
    expect(await getRegistryEntry(kv, "https://example.com")).toBeNull();
  });

  it("parses a stored entry", async () => {
    const entry: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "blessed", generatedAt: 1, blessedAt: 2 }],
    };
    const kv = fakeKv({ "origin:https://example.com": JSON.stringify(entry) });
    expect(await getRegistryEntry(kv, "https://example.com")).toEqual(entry);
  });

  it("returns null on malformed JSON rather than throwing", async () => {
    const kv = fakeKv({ "origin:https://example.com": "{not json" });
    expect(await getRegistryEntry(kv, "https://example.com")).toBeNull();
  });

  it("returns null when the stored value has no tools array", async () => {
    const kv = fakeKv({ "origin:https://example.com": JSON.stringify({ foo: 1 }) });
    expect(await getRegistryEntry(kv, "https://example.com")).toBeNull();
  });
});

describe("blessedManifests", () => {
  it("returns an empty array for a null entry", () => {
    expect(blessedManifests(null)).toEqual([]);
  });

  it("keeps only blessed tools, unwrapped to ToolManifest", () => {
    const entry: RegistryEntry = {
      tools: [
        { manifest: TOOL, status: "blessed", generatedAt: 1, blessedAt: 2 },
        { manifest: { ...TOOL, name: "draft_tool" }, status: "draft", generatedAt: 1 },
        { manifest: { ...TOOL, name: "declined_tool" }, status: "declined", generatedAt: 1 },
      ],
    };
    expect(blessedManifests(entry)).toEqual([TOOL]);
  });
});

describe("getBlessedManifestByName", () => {
  it("returns undefined when there is no tool key", async () => {
    const kv = fakeKv({});
    expect(await getBlessedManifestByName(kv, "search_widgets_on_example_com")).toBeUndefined();
  });

  it("parses the stored manifest", async () => {
    const kv = fakeKv({ "tool:search_widgets_on_example_com": JSON.stringify(TOOL) });
    expect(await getBlessedManifestByName(kv, "search_widgets_on_example_com")).toEqual(TOOL);
  });

  it("returns undefined for a malformed stored value (missing required fields)", async () => {
    const kv = fakeKv({ "tool:bad": JSON.stringify({ name: "bad" }) });
    expect(await getBlessedManifestByName(kv, "bad")).toBeUndefined();
  });
});

/** A KV whose `put` actually stores, unlike the read-only `fakeKv` above. */
function writableKv(store: Record<string, string>): KvLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
  };
}

describe("recordDraftTools", () => {
  it("adds new tools as drafts", async () => {
    const store: Record<string, string> = {};
    const entry = await recordDraftTools(writableKv(store), "https://example.com", [TOOL]);
    expect(entry.tools).toHaveLength(1);
    expect(entry.tools[0].status).toBe("draft");
    expect(entry.tools[0].manifest).toEqual(TOOL);
  });

  it("does not duplicate a tool name already present in any status", async () => {
    const existing: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "blessed", generatedAt: 1, blessedAt: 2 }],
    };
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify(existing),
    };
    const entry = await recordDraftTools(writableKv(store), "https://example.com", [TOOL]);
    expect(entry.tools).toHaveLength(1);
    expect(entry.tools[0].status).toBe("blessed");
  });
});

describe("blessTool", () => {
  it("marks the named tool blessed and writes the tool: lookup key", async () => {
    const existing: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "draft", generatedAt: 1 }],
    };
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify(existing),
    };
    const entry = await blessTool(writableKv(store), "https://example.com", TOOL.name);
    expect(entry?.tools[0].status).toBe("blessed");
    expect(entry?.tools[0].blessedAt).toBeGreaterThan(0);
    expect(JSON.parse(store[`tool:${TOOL.name}`])).toEqual(TOOL);
  });

  it("returns null when the origin has no entry", async () => {
    const kv: KvLike = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    expect(await blessTool(kv, "https://example.com", TOOL.name)).toBeNull();
  });

  it("writes no tool: key when the name is not in the entry", async () => {
    const existing: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "draft", generatedAt: 1 }],
    };
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify(existing),
    };
    await blessTool(writableKv(store), "https://example.com", "not_a_tool");
    expect(store["tool:not_a_tool"]).toBeUndefined();
  });
});

describe("declineTool", () => {
  it("marks the named tool declined without writing a tool: key", async () => {
    const existing: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "draft", generatedAt: 1 }],
    };
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify(existing),
    };
    const entry = await declineTool(writableKv(store), "https://example.com", TOOL.name);
    expect(entry?.tools[0].status).toBe("declined");
    expect(store[`tool:${TOOL.name}`]).toBeUndefined();
  });

  it("returns null when the origin has no entry", async () => {
    const kv: KvLike = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    expect(await declineTool(kv, "https://example.com", TOOL.name)).toBeNull();
  });
});
