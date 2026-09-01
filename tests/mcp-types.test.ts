import { describe, expect, it } from "vitest";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDescriptor,
} from "../shared/mcp";

describe("MCP protocol types", () => {
  it("JsonRpcRequest carries method and optional id/params", () => {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };
    expect(req.method).toBe("tools/list");
  });

  it("JsonRpcResponse is either result or error", () => {
    const ok: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    };
    expect(ok.error).toBeUndefined();
    const err: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    };
    expect(err.error?.code).toBe(-32601);
  });

  it("McpToolDescriptor matches MCP tools/list item shape", () => {
    const t: McpToolDescriptor = {
      name: "search_catalog_on_allbirds_com",
      description: "Search Allbirds' catalog.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };
    expect(t.inputSchema.type).toBe("object");
  });
});
