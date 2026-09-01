import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcId,
} from "../../shared/mcp";

/** JSON-RPC 2.0 standard error codes (spec §Error object). */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export type ParseOk = { ok: true; req: JsonRpcRequest };
export type ParseErr = { ok: false; error: JsonRpcResponse };
export type ParseResult = ParseOk | ParseErr;

export function parseRequest(body: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return {
      ok: false,
      error: makeError(null, JSONRPC_PARSE_ERROR, "Parse error"),
    };
  }
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      error: makeError(null, JSONRPC_INVALID_REQUEST, "Invalid Request"),
    };
  }
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== "2.0") {
    return {
      ok: false,
      error: makeError(null, JSONRPC_INVALID_REQUEST, "Invalid Request"),
    };
  }
  if (typeof v.method !== "string" || v.method.length === 0) {
    return {
      ok: false,
      error: makeError(idOf(v.id), JSONRPC_INVALID_REQUEST, "Invalid Request"),
    };
  }
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: v.method,
    ...(v.id !== undefined ? { id: idOf(v.id) } : {}),
    ...(v.params !== undefined ? { params: v.params as Record<string, unknown> } : {}),
  };
  return { ok: true, req };
}

export function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function errorResult(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcError = { code, message, ...(data !== undefined ? { data } : {}) };
  return { jsonrpc: "2.0", id, error };
}

function makeError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return errorResult(id, code, message);
}

function idOf(v: unknown): JsonRpcId {
  if (typeof v === "string" || typeof v === "number" || v === null) return v;
  return null;
}
