import { describe, expect, it } from "vitest";
import {
  parseRequest,
  success,
  errorResult,
  JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
} from "../worker/mcp/jsonrpc";

describe("JSON-RPC 2.0 envelope", () => {
  it("parses a valid request", () => {
    const r = parseRequest('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.method).toBe("ping");
  });

  it("parses a request without an id (notification)", () => {
    const r = parseRequest('{"jsonrpc":"2.0","method":"notifications/ping"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.id).toBeUndefined();
  });

  it("rejects non-JSON with parse error", () => {
    const r = parseRequest("not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error?.code).toBe(JSONRPC_PARSE_ERROR);
  });

  it("rejects wrong protocol version", () => {
    const r = parseRequest('{"jsonrpc":"1.0","id":1,"method":"ping"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error?.code).toBe(JSONRPC_INVALID_REQUEST);
  });

  it("rejects missing method", () => {
    const r = parseRequest('{"jsonrpc":"2.0","id":1}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error?.code).toBe(JSONRPC_INVALID_REQUEST);
  });

  it("builds a success response", () => {
    const resp = success(1, { tools: [] });
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ tools: [] });
  });

  it("builds a standard method-not-found error", () => {
    const resp = errorResult(1, JSONRPC_METHOD_NOT_FOUND, "Method not found");
    expect(resp.error?.code).toBe(-32601);
  });
});
