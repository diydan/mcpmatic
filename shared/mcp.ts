/**
 * Subset of the MCP wire types we use in Phase 1.
 * The protocol spec is JSON-RPC 2.0; this file only types what we accept or emit.
 */

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

/** Item returned in tools/list. Mirrors MCP spec §Tools. */
export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Item returned inside tools/call result.content[]. */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type McpCallResult = {
  content: McpContentBlock[];
  isError?: boolean;
};
