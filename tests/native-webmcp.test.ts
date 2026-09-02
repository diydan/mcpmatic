import { describe, expect, it, vi } from "vitest";
import { callNativeTool, discoverNativeTools } from "../worker/native-webmcp";

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
        { name: "search_catalog", description: "Search the store catalog." },
        { name: "update_cart", description: "Add or change cart lines." },
      ],
    }));
    expect(out.ok).toBe(true);
    expect(out.tools?.map((t) => t.name)).toEqual(["search_catalog", "update_cart"]);
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
