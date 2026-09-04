import { describe, expect, it, vi } from "vitest";
import { recordDraftTools, getRegistryEntry, type KvLike } from "../worker/manifest-registry";
import type { ToolManifest } from "../shared/manifest";

const TOOL: ToolManifest = {
  name: "search_widgets_on_example_com",
  description: "search widgets",
  origin: "https://example.com",
  inputSchema: { type: "object", properties: {} },
  steps: [{ action: "goto", url: "https://example.com" }],
};

function fakeKv(): KvLike {
  const store: Record<string, string> = {};
  return {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
  };
}

/**
 * maybeAutoGenerate's guards are not reachable without a full SessionDO
 * (Durable Object storage, a live browser), so this locks down the two
 * properties those guards depend on instead.
 */
describe("generation trigger contract", () => {
  it("recordDraftTools is idempotent against repeated calls for the same origin", async () => {
    const kv = fakeKv();
    await recordDraftTools(kv, "https://example.com", [TOOL]);
    const second = await recordDraftTools(kv, "https://example.com", [TOOL]);
    expect(second.tools).toHaveLength(1);
  });

  it("leaves an entry behind that the skip-if-present guard can see", async () => {
    const kv = fakeKv();
    expect(await getRegistryEntry(kv, "https://example.com")).toBeNull();
    await recordDraftTools(kv, "https://example.com", [TOOL]);
    expect(await getRegistryEntry(kv, "https://example.com")).not.toBeNull();
  });

  it("records nothing resolvable by name until a approve writes the tool: key", async () => {
    const kv = fakeKv();
    await recordDraftTools(kv, "https://example.com", [TOOL]);
    expect(await kv.get(`tool:${TOOL.name}`)).toBeNull();
  });
});
