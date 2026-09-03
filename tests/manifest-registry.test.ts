import { describe, expect, it, vi } from "vitest";
import {
  getRegistryEntry,
  blessedManifests,
  getBlessedManifestByName,
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
