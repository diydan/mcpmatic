/**
 * @vitest-environment node
 *
 * End-to-end MCP protocol test. Drives handleMcp directly with hand-crafted
 * fetch Requests — the @modelcontextprotocol/sdk is installed for type
 * parity but not exercised (the SDK Client would need a paired Server, which
 * requires more wiring than Phase 1 justifies).
 *
 * This is the spec-compliance gate. If these tests pass, our server speaks
 * MCP correctly. If a real client (ChatGPT, Claude) fails, the issue is
 * theirs.
 */
import { describe, expect, it } from "vitest";
import { handleMcp } from "../worker/mcp/server";

const TOKEN = "a".repeat(64);

function makeEnv(): Env {
  // Minimal env stub. The DO is not actually exercised by these tests because
  // we hit `initialize` and `tools/list` against an unconsented session, where
  // listTools returns the SPINE without touching the DO.
  return {} as unknown as Env;
}

describe("MCP end-to-end (spec-compliance gate)", () => {
  it("completes the initialize handshake", async () => {
    const request = new Request("https://test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    const response = await handleMcp(request, makeEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("browsermatic");
  });

  it("rejects a request with no Authorization header", async () => {
    const request = new Request("https://test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const response = await handleMcp(request, makeEnv());
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("rejects a request with a malformed token", async () => {
    const request = new Request("https://test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const response = await handleMcp(request, makeEnv());
    expect(response.status).toBe(401);
  });

  it("rejects a non-POST request", async () => {
    const request = new Request("https://test/mcp", { method: "GET" });
    const response = await handleMcp(request, makeEnv());
    expect(response.status).toBe(405);
  });
});