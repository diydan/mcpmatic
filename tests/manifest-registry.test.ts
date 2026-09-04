import { describe, expect, it, vi } from "vitest";
import {
  getRegistryEntry,
  approvedManifests,
  getApprovedManifestByName,
  recordDraftTools,
  approveTool,
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
    delete: vi.fn(async () => {}),
  };
}

describe("getRegistryEntry", () => {
  it("returns null when the origin has no entry", async () => {
    const kv = fakeKv({});
    expect(await getRegistryEntry(kv, "https://example.com")).toBeNull();
  });

  it("parses a stored entry", async () => {
    const entry: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "approved", generatedAt: 1, approvedAt: 2 }],
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

describe("approvedManifests", () => {
  it("returns an empty array for a null entry", () => {
    expect(approvedManifests(null)).toEqual([]);
  });

  it("keeps only approved tools, unwrapped to ToolManifest", () => {
    const entry: RegistryEntry = {
      tools: [
        { manifest: TOOL, status: "approved", generatedAt: 1, approvedAt: 2 },
        { manifest: { ...TOOL, name: "draft_tool" }, status: "draft", generatedAt: 1 },
        { manifest: { ...TOOL, name: "declined_tool" }, status: "declined", generatedAt: 1 },
      ],
    };
    expect(approvedManifests(entry)).toEqual([TOOL]);
  });
});

describe("getApprovedManifestByName", () => {
  it("returns undefined when there is no tool key", async () => {
    const kv = fakeKv({});
    expect(await getApprovedManifestByName(kv, "search_widgets_on_example_com")).toBeUndefined();
  });

  it("parses the stored manifest", async () => {
    const kv = fakeKv({ "tool:search_widgets_on_example_com": JSON.stringify(TOOL) });
    expect(await getApprovedManifestByName(kv, "search_widgets_on_example_com")).toEqual(TOOL);
  });

  it("returns undefined for a malformed stored value (missing required fields)", async () => {
    const kv = fakeKv({ "tool:bad": JSON.stringify({ name: "bad" }) });
    expect(await getApprovedManifestByName(kv, "bad")).toBeUndefined();
  });
});

/** A KV whose `put` actually stores, unlike the read-only `fakeKv` above. */
function writableKv(store: Record<string, string>): KvLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete store[key];
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
      tools: [{ manifest: TOOL, status: "approved", generatedAt: 1, approvedAt: 2 }],
    };
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify(existing),
    };
    const entry = await recordDraftTools(writableKv(store), "https://example.com", [TOOL]);
    expect(entry.tools).toHaveLength(1);
    expect(entry.tools[0].status).toBe("approved");
  });
});

describe("approveTool", () => {
  it("marks the named tool approved and writes the tool: lookup key", async () => {
    const existing: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "draft", generatedAt: 1 }],
    };
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify(existing),
    };
    const entry = await approveTool(writableKv(store), "https://example.com", TOOL.name);
    expect(entry?.tools[0].status).toBe("approved");
    expect(entry?.tools[0].approvedAt).toBeGreaterThan(0);
    expect(JSON.parse(store[`tool:${TOOL.name}`])).toEqual(TOOL);
  });

  it("returns null when the origin has no entry", async () => {
    const kv: KvLike = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    expect(await approveTool(kv, "https://example.com", TOOL.name)).toBeNull();
  });

  it("writes no tool: key when the name is not in the entry", async () => {
    const existing: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "draft", generatedAt: 1 }],
    };
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify(existing),
    };
    await approveTool(writableKv(store), "https://example.com", "not_a_tool");
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

  it("deletes the tool: key when declining a tool that was already approved", async () => {
    // Decline is the revoke path, not just a first refusal. `manifestFor`
    // resolves a name straight from `tool:<name>` and never re-reads the
    // per-origin status, so leaving that key behind would keep a revoked
    // tool callable by name while the listing showed it as declined.
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify({
        tools: [{ manifest: TOOL, status: "draft", generatedAt: 1 }],
      } satisfies RegistryEntry),
    };
    const kv = writableKv(store);
    await approveTool(kv, "https://example.com", TOOL.name);
    expect(store[`tool:${TOOL.name}`]).toBeDefined();

    const entry = await declineTool(kv, "https://example.com", TOOL.name);
    expect(entry?.tools[0].status).toBe("declined");
    expect(store[`tool:${TOOL.name}`]).toBeUndefined();
  });

  it("returns null when the origin has no entry", async () => {
    const kv: KvLike = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    expect(await declineTool(kv, "https://example.com", TOOL.name)).toBeNull();
  });
});
