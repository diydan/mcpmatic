import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpCallResult,
} from "../../shared/mcp";
import {
  success,
  errorResult,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INTERNAL_ERROR,
} from "./jsonrpc";
import { authenticate } from "./auth";

/**
 * Subset of the SessionDO surface the MCP handler uses. In production this is
 * `DurableObjectStub<SessionDO>`; in tests we inject a fake.
 */
export type McpSession = {
  listTools: () => Promise<unknown>;
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; text: string }>;
};

/**
 * Dispatch a parsed JSON-RPC request against the session. Pure function — no
 * env, no I/O. The HTTP wrapper (handleMcp) does auth and env lookup; this
 * does protocol. `session` is only required for `tools/list` and `tools/call`;
 * it may be `null` for protocol-only methods (`initialize`, `ping`) which
 * don't touch the DO.
 */
export async function dispatch(
  req: JsonRpcRequest,
  session: McpSession | null,
): Promise<JsonRpcResponse> {
  const id = req.id ?? null;

  if (req.method === "initialize") {
    return success(id, {
      protocolVersion: "2025-03-26",
      serverInfo: { name: "mcpmatic", version: "0.1.0" },
      capabilities: { tools: { listChanged: false } },
    });
  }

  if (req.method === "ping") {
    return success(id, {});
  }

  if (req.method === "tools/list") {
    if (!session) {
      return errorResult(id, JSONRPC_INTERNAL_ERROR, "session unavailable");
    }
    try {
      const tools = await session.listTools();
      return success(id, { tools });
    } catch (err) {
      return errorResult(
        id,
        JSONRPC_INTERNAL_ERROR,
        err instanceof Error ? err.message : "tools/list failed",
      );
    }
  }

  if (req.method === "tools/call") {
    if (!session) {
      return errorResult(id, JSONRPC_INTERNAL_ERROR, "session unavailable");
    }
    const params = req.params ?? {};
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== "string") {
      return errorResult(
        id,
        JSONRPC_INVALID_PARAMS,
        "tools/call requires params.name (string)",
      );
    }
    try {
      const r = await session.callTool(name, args);
      const result: McpCallResult = {
        content: [{ type: "text", text: r.text }],
        ...(r.ok ? {} : { isError: true }),
      };
      return success(id, result);
    } catch (err) {
      return errorResult(
        id,
        JSONRPC_INTERNAL_ERROR,
        err instanceof Error ? err.message : "tools/call failed",
      );
    }
  }

  return errorResult(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${req.method}`);
}

/**
 * HTTP entry point. Authenticates the bearer token, looks up the session DO,
 * parses the JSON-RPC envelope, dispatches, and returns the JSON-RPC response.
 */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const body = await request.text();
  const { parseRequest } = await import("./jsonrpc");
  const parsed = parseRequest(body);
  if (!parsed.ok) return new Response(JSON.stringify(parsed.error), {
    status: 200, // JSON-RPC errors are 200 with error envelope
    headers: { "content-type": "application/json" },
  });
  if (!parsed.req.id) {
    // Notifications get no response.
    return new Response("", { status: 204 });
  }

  // Only fetch the session DO stub when the method actually needs it. Protocol
  // methods (`initialize`, `ping`, unknown) don't touch the DO, so this keeps
  // e2e tests for the protocol layer free of DO mocking.
  const needsSession =
    parsed.req.method === "tools/list" || parsed.req.method === "tools/call";
  const session: McpSession | null = needsSession
    ? (() => {
        const stub = env.SESSION.getByName(auth.token);
        return {
          listTools: () => stub.listTools() as Promise<unknown>,
          callTool: (name, args) =>
            stub.callTool(name, args) as Promise<{ ok: boolean; text: string }>,
        };
      })()
    : null;
  const resp = await dispatch(parsed.req, session);
  return new Response(JSON.stringify(resp), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "MCP-Protocol-Version": "2025-03-26",
    },
  });
}
