/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { dispatch } from "../worker/mcp/server";

// The dispatch function takes a parsed JSON-RPC request plus a session
// interface (the bits of SessionDO it needs). Tests inject a fake session.
type FakeSession = {
  listTools: () => Promise<unknown>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
};

describe("MCP handler dispatch", () => {
  it("initialize returns server info and tools capability", async () => {
    const resp = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {} as FakeSession,
    );
    expect(resp.result).toMatchObject({
      serverInfo: { name: "mcpmatic" },
      capabilities: { tools: { listChanged: false } },
    });
  });

  it("ping returns empty result", async () => {
    const resp = await dispatch(
      { jsonrpc: "2.0", id: 2, method: "ping" },
      {} as FakeSession,
    );
    expect(resp.result).toEqual({});
  });

  it("tools/list delegates to the session", async () => {
    const fake: FakeSession = {
      listTools: async () => [{ name: "get_page_state", description: "x", inputSchema: {} }],
      callTool: async () => ({ ok: true, text: "" }),
    };
    const resp = await dispatch(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      fake,
    );
    expect((resp.result as { tools: unknown[] }).tools).toHaveLength(1);
  });

  it("tools/call delegates to the session and wraps the result in MCP content blocks", async () => {
    const fake: FakeSession = {
      listTools: async () => [],
      callTool: async () => ({ ok: true, text: "found 3 products" }),
    };
    const resp = await dispatch(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "search_catalog_on_allbirds_com", arguments: { query: "shoes" } },
      },
      fake,
    );
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.content).toEqual([{ type: "text", text: "found 3 products" }]);
    expect(result.isError).toBeUndefined();
  });

  it("tools/call marks a failed tool result with isError=true", async () => {
    const fake: FakeSession = {
      listTools: async () => [],
      callTool: async () => ({ ok: false, text: "origin not consented" }),
    };
    const resp = await dispatch(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "search_catalog_on_allbirds_com", arguments: {} },
      },
      fake,
    );
    const result = resp.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("unknown method returns method-not-found error", async () => {
    const resp = await dispatch(
      { jsonrpc: "2.0", id: 6, method: "resources/list" },
      {} as FakeSession,
    );
    expect(resp.error?.code).toBe(-32601);
  });
});
