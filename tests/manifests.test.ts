import { describe, expect, it, vi } from "vitest";
import { manifestFor, originOfTool } from "../worker/manifests";
import type { KvLike } from "../worker/manifest-registry";
import type { ToolManifest } from "../shared/manifest";

const GENERATED: ToolManifest = {
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

describe("manifestFor", () => {
  it("resolves a static (hand-authored) tool without touching kv", async () => {
    const kv = fakeKv({});
    const m = await manifestFor("search_flights_on_kayak_com", kv);
    expect(m?.origin).toBe("https://www.kayak.com");
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("resolves a registry-backed tool on a static miss", async () => {
    const kv = fakeKv({ "tool:search_widgets_on_example_com": JSON.stringify(GENERATED) });
    const m = await manifestFor("search_widgets_on_example_com", kv);
    expect(m).toEqual(GENERATED);
  });

  it("returns undefined when kv is omitted and the tool isn't static", async () => {
    expect(await manifestFor("search_widgets_on_example_com")).toBeUndefined();
  });

  it("returns undefined for an unknown tool even with kv present", async () => {
    const kv = fakeKv({});
    expect(await manifestFor("nonexistent_tool", kv)).toBeUndefined();
  });

  it("resolves a spine tool without touching kv", async () => {
    const kv = fakeKv({});
    const m = await manifestFor("get_page_state", kv);
    expect(m).toBeUndefined();
    expect(kv.get).not.toHaveBeenCalled();
  });
});

describe("originOfTool", () => {
  it("returns null for spine tools", async () => {
    expect(await originOfTool("get_page_state")).toBeNull();
    expect(await originOfTool("navigate_to")).toBeNull();
    expect(await originOfTool("list_remote_tools")).toBeNull();
    expect(await originOfTool("call_remote_tool")).toBeNull();
    expect(await originOfTool("list_available_origins")).toBeNull();
  });

  it("returns the manifest origin for a static tool", async () => {
    expect(await originOfTool("search_flights_on_kayak_com")).toBe("https://www.kayak.com");
  });

  it("returns the manifest origin for a registry-backed tool", async () => {
    const kv = fakeKv({ "tool:search_widgets_on_example_com": JSON.stringify(GENERATED) });
    expect(await originOfTool("search_widgets_on_example_com", kv)).toBe("https://example.com");
  });
});
