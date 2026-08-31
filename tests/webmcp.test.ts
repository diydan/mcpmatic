/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureModelContext } from "../src/lib/webmcp-polyfill";
import { registerAll } from "../src/lib/register-all";
import type { ToolManifest } from "../shared/manifest";

const kayak: ToolManifest = {
  name: "search_flights_on_kayak_com",
  description: "Search flights on kayak.com",
  origin: "https://www.kayak.com",
  inputSchema: {
    type: "object",
    properties: { origin: { type: "string" } },
    additionalProperties: false,
  },
  fillsFrom: ["address.postcode"],
  steps: [],
};

describe("registerAll is the only path", () => {
  afterEach(() => {
    Object.defineProperty(document, "modelContext", {
      value: undefined,
      configurable: true,
    });
  });

  it("discovers via getTools and invokes via executeTool", async () => {
    const remote = vi.fn(async () => "ok");
    const ac = await registerAll({
      manifests: [kayak],
      consented: new Set(["https://www.kayak.com"]),
      executeRemote: remote,
      bless: async () => true,
      resolveFields: (paths) =>
        Object.fromEntries(paths.map((p) => [p, "EC2A 3DZ"])),
    });

    const mc = ensureModelContext();
    const spy = vi.spyOn(mc, "executeTool");
    const tools = await mc.getTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("get_page_state");
    expect(names).toContain("search_flights_on_kayak_com");

    const tool = tools.find((t) => t.name === "get_page_state");
    expect(tool).toBeTruthy();
    await mc.executeTool(tool!, {});
    expect(spy).toHaveBeenCalled();
    expect(remote).toHaveBeenCalledWith("get_page_state", expect.any(Object));

    ac.abort();
    const after = await mc.getTools();
    expect(after.find((t) => t.name === "get_page_state")).toBeUndefined();
  });

  it("does not register an unconsented origin", async () => {
    await registerAll({
      manifests: [kayak],
      consented: new Set(),
      executeRemote: async () => "ok",
      bless: async () => true,
      resolveFields: () => ({}),
    });
    const tools = await ensureModelContext().getTools();
    expect(tools.find((t) => t.name === "search_flights_on_kayak_com")).toBeUndefined();
  });

  it("rejects a duplicate registerTool name until aborted", async () => {
    const mc = ensureModelContext();
    await mc.registerTool({
      name: "dup_tool",
      description: "x",
      execute: async () => "a",
    });
    await expect(
      mc.registerTool({
        name: "dup_tool",
        description: "y",
        execute: async () => "b",
      }),
    ).rejects.toMatchObject({ name: "InvalidStateError" });
  });
});
