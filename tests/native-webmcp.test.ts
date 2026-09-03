import { describe, expect, it, vi } from "vitest";
import {
  callNativeTool,
  discoverNativeTools,
  parseCallRemoteArgs,
  sanitizeDiscoveredTools,
} from "../worker/native-webmcp";

describe("callNativeTool", () => {
  it("reports the remote tool's own failure, not absence", async () => {
    // The store has the tool and it threw. Saying "not registered" here sends
    // the operator debugging the wrong thing on the primary demo path.
    const evaluate = vi.fn(async () => ({
      used: false,
      reason: "threw" as const,
      error: "variant not found",
    }));
    const out = await callNativeTool(evaluate, "update_cart", { instruction: "x" });
    expect(out).toEqual({
      used: false,
      reason: "threw",
      error: "variant not found",
    });
  });

  it("distinguishes a site with no WebMCP from a missing tool", async () => {
    const noWebmcp = await callNativeTool(
      vi.fn(async () => ({ used: false, reason: "no-webmcp" as const })),
      "search_catalog",
      {},
    );
    const noTool = await callNativeTool(
      vi.fn(async () => ({ used: false, reason: "no-tool" as const })),
      "search_catalog",
      {},
    );
    expect(noWebmcp.reason).toBe("no-webmcp");
    expect(noTool.reason).toBe("no-tool");
  });

  it("turns an evaluate failure into a reason rather than swallowing it", async () => {
    const out = await callNativeTool(
      vi.fn(async () => {
        throw new Error("Execution context was destroyed");
      }),
      "search_catalog",
      {},
    );
    expect(out).toMatchObject({
      used: false,
      reason: "threw",
      error: "Execution context was destroyed",
    });
  });

  it("passes the remote tool's text through on success", async () => {
    const out = await callNativeTool(
      vi.fn(async () => ({ used: true, text: "3 results" })),
      "search_catalog",
      { query: "wool" },
    );
    expect(out).toEqual({ used: true, text: "3 results" });
  });
});

describe("discoverNativeTools", () => {
  it("returns the remote page's own tool list", async () => {
    const out = await discoverNativeTools(async () => ({
      ok: true,
      tools: [
        {
          name: "search_catalog",
          description: "Search the store catalog.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
        { name: "update_cart", description: "Add or change cart lines.", inputSchema: { type: "object", properties: {} } },
      ],
    }));
    expect(out.ok).toBe(true);
    expect(out.tools?.map((t) => t.name)).toEqual(["search_catalog", "update_cart"]);
    expect(out.tools?.[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  it("distinguishes an empty list from a missing implementation", async () => {
    // We inject modelContext, so it is always present; an empty tool list is a
    // real answer about the site, not evidence that WebMCP is absent.
    const out = await discoverNativeTools(async () => ({ ok: true, tools: [] }));
    expect(out.ok).toBe(true);
    expect(out.tools).toEqual([]);
    expect(out.reason).toBeUndefined();
  });

  it("reports a site with no WebMCP as a reason, not an error", async () => {
    const out = await discoverNativeTools(async () => ({
      ok: false,
      reason: "no-webmcp" as const,
    }));
    expect(out).toEqual({ ok: false, reason: "no-webmcp" });
  });

  it("turns an evaluate failure into a reason rather than throwing", async () => {
    const out = await discoverNativeTools(async () => {
      throw new Error("Execution context was destroyed");
    });
    expect(out).toMatchObject({ ok: false, reason: "threw" });
  });
});

describe("sanitizeDiscoveredTools", () => {
  it("keeps a JSON schema and drops tools with illegal names", () => {
    const tools = sanitizeDiscoveredTools([
      {
        name: "search_catalog",
        description: "Search",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      { name: "not a tool", description: "spaces" },
      { name: "ok_tool", description: "x\u0000y", inputSchema: "nope" },
    ]);
    expect(tools.map((t) => t.name)).toEqual(["search_catalog", "ok_tool"]);
    expect(tools[0].inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
    expect(tools[1].inputSchema).toEqual({ type: "object", properties: {} });
    expect(tools[1].description).not.toContain("\u0000");
  });
});

describe("parseCallRemoteArgs", () => {
  it("reads the native name and argument object", () => {
    expect(
      parseCallRemoteArgs({
        name: "search_catalog",
        arguments: { catalog: { query: "wool" } },
        origin: "https://www.allbirds.com",
      }),
    ).toEqual({
      ok: true,
      name: "search_catalog",
      arguments: { catalog: { query: "wool" } },
      origin: "https://www.allbirds.com",
    });
  });

  it("refuses an illegal native name", () => {
    const out = parseCallRemoteArgs({ name: "search catalog" });
    expect(out.ok).toBe(false);
  });

  it("defaults missing arguments to an empty object", () => {
    expect(parseCallRemoteArgs({ name: "get_cart" })).toEqual({
      ok: true,
      name: "get_cart",
      arguments: {},
      origin: null,
    });
  });
});

describe("callNativeTool classifies a schema mismatch", () => {
  const declared = {
    type: "object",
    properties: { variantId: { type: "string" }, quantity: { type: "number" } },
    required: ["variantId", "quantity"],
  };

  it("does not call the remote tool when the args cannot satisfy its schema", async () => {
    // The merchant-facing signal: their schema requires a field the agent
    // never sends. Calling anyway would return "threw" and lose the reason.
    const evaluate = vi.fn(async () => ({ used: true, text: "ok" }));
    const out = await callNativeTool(
      evaluate,
      "update_cart",
      { variantId: "v1" },
      declared,
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(out.used).toBe(false);
    expect(out.reason).toBe("schema-mismatch");
  });

  it("names the missing field without quoting any value", async () => {
    const out = await callNativeTool(
      vi.fn(async () => ({ used: true })),
      "update_cart",
      { variantId: "secret-value" },
      declared,
    );
    expect(out.error).toContain("quantity");
    expect(out.error).not.toContain("secret-value");
  });

  it("calls through when the args satisfy the schema", async () => {
    const evaluate = vi.fn(async () => ({ used: true, text: "ok" }));
    const out = await callNativeTool(
      evaluate,
      "update_cart",
      { variantId: "v1", quantity: 2 },
      declared,
    );
    expect(evaluate).toHaveBeenCalled();
    expect(out.used).toBe(true);
  });

  it("calls through when no schema is known, rather than inventing a failure", async () => {
    const evaluate = vi.fn(async () => ({ used: true, text: "ok" }));
    await callNativeTool(evaluate, "update_cart", {}, undefined);
    expect(evaluate).toHaveBeenCalled();
  });
});
