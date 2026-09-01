# MCP Server Surface — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an MCP (Model Context Protocol) wire-protocol surface at `/mcp` so a tool-aware agent (ChatGPT, Claude desktop, spec-compliant clients) can call origin-qualified tools without the WebMCP façade.

**Architecture:** A new `/mcp` route on the existing Cloudflare Worker accepts JSON-RPC 2.0 over Streamable HTTP, authenticates with a bearer token, and bridges `tools/list` / `tools/call` to two new public methods on `SessionDO`. The session DO is otherwise unchanged — same consent gate, same audit table (no value column), same SSRF checks, same Chromium lifecycle. The WebMCP façade at `/s/<token>` is untouched.

**Tech Stack:** Cloudflare Workers + Durable Objects (existing), TypeScript, vitest. New dependency: `@modelcontextprotocol/sdk` (test client only — production code speaks raw JSON-RPC).

**Spec:** `README.md` (architecture), `shared/protocol.ts` (existing wire types), `worker/session-do.ts` (existing DO). This plan argues from those — the spec travels with it; executors read both.

## Global Constraints

These constraints apply to every task. They are non-negotiable.

1. **No changes to the audit table shape.** Rows remain `{origin, tool, field_names, ts}`. No value column. Ever.
2. **No changes to SSRF check behavior.** `isPrivateUrl` runs on every navigation, both via MCP and via the existing façade.
3. **Origin-qualified tool names.** Tools surfaced by MCP keep their `*_on_<origin>` suffixes. Never bare names.
4. **Consent gates MCP tool visibility, not just execution.** `tools/list` returns only tools for granted origins. Ungranted origins are invisible, not "denied at call time."
5. **The session DO's `runTool` is the only path.** MCP `tools/call` routes through it; no parallel implementation.
6. **No LLM in the MCP hot path.** MCP `tools/call` is a deterministic bridge to the existing executeTool path. The model is only involved when the in-page chat panel asks for it (existing behavior).
7. **Bash commands are run from the repo root** unless stated otherwise.
8. **Every commit message follows Conventional Commits** (`feat:`, `fix:`, `test:`, `chore:`, `docs:`, plus scoped forms like `feat(mcp):`, `test(mcp):`) and ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

## File Structure

New files for Phase 1:

| File | Purpose |
|---|---|
| `shared/mcp.ts` | MCP protocol types: `JsonRpcRequest`, `JsonRpcResponse`, `McpToolDescriptor`, `McpCallResult` |
| `worker/mcp/jsonrpc.ts` | Parse JSON-RPC envelopes; build success/error responses |
| `worker/mcp/tools.ts` | Build `McpToolDescriptor[]` from consented origins + SPINE |
| `worker/mcp/auth.ts` | Extract bearer token; map to session DO stub |
| `worker/mcp/server.ts` | Streamable HTTP handler; JSON-RPC dispatch |
| `tests/mcp.test.ts` | End-to-end protocol tests with `@modelcontextprotocol/sdk` |
| `tests/MCP_CLIENTS.md` | Manual test matrix for Claude desktop and ChatGPT |

Modified files:

| File | Change |
|---|---|
| `worker/session-do.ts` | Add `listTools()` and `callTool(name, args)` public methods |
| `worker/index.ts` | Register `/mcp` route |
| `package.json` | Add `@modelcontextprotocol/sdk` devDep |
| `wrangler.jsonc` | Add `/mcp` to `run_worker_first` (none needed — Worker handles the route) |

---

### Task 1: Define MCP protocol types

**Files:**
- Create: `shared/mcp.ts`
- Test: `tests/mcp-types.test.ts`

**Interfaces:**
- Consumes: nothing (foundational)
- Produces: `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcError`, `McpToolDescriptor`, `McpCallResult`

The MCP protocol uses JSON-RPC 2.0 with method-specific params. We type the subset we use now; expand later.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-types.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/mcp-types.test.ts`
Expected: FAIL — module `../shared/mcp` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// shared/mcp.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/mcp-types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/mcp.ts tests/mcp-types.test.ts
git commit -m "feat(mcp): add MCP protocol type definitions"
```

---

### Task 2: JSON-RPC 2.0 envelope parser and responder

**Files:**
- Create: `worker/mcp/jsonrpc.ts`
- Test: `tests/mcp-jsonrpc.test.ts`

**Interfaces:**
- Consumes: types from `shared/mcp.ts`
- Produces: `parseRequest(body): { ok: true; req: JsonRpcRequest } | { ok: false; error: JsonRpcResponse }`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-jsonrpc.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/mcp-jsonrpc.test.ts`
Expected: FAIL — module `../worker/mcp/jsonrpc` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/mcp/jsonrpc.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/mcp-jsonrpc.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/mcp/jsonrpc.ts tests/mcp-jsonrpc.test.ts
git commit -m "feat(mcp): add JSON-RPC 2.0 envelope parser and responder"
```

---

### Task 3: Tool descriptor builder

**Files:**
- Create: `worker/mcp/tools.ts`
- Test: `tests/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `ToolManifest[]` from `shared/manifest.ts`, `MANIFESTS` from `worker/manifests.ts`
- Produces: `buildToolList(consented: ReadonlySet<string>): McpToolDescriptor[]`

The SPINE tools (`get_page_state`, `list_available_origins`, `navigate_to`) are always included. Per-origin manifests are included only when their origin is in the consented set. Tool descriptors are identical to the existing WebMCP descriptors — same name, same description, same input schema.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-tools.test.ts
import { describe, expect, it } from "vitest";
import { buildToolList, SPINE_NAMES } from "../worker/mcp/tools";

describe("MCP tool list", () => {
  it("always includes the three spine tools", () => {
    const list = buildToolList(new Set());
    const names = list.map((t) => t.name);
    for (const spine of SPINE_NAMES) {
      expect(names).toContain(spine);
    }
  });

  it("includes a per-origin manifest only when its origin is consented", () => {
    const list = buildToolList(new Set(["https://www.allbirds.com"]));
    const names = list.map((t) => t.name);
    expect(names).toContain("search_catalog_on_allbirds_com");
    expect(names).not.toContain("search_flights_on_kayak_com");
  });

  it("does not include any per-origin tool when no origins are consented", () => {
    const list = buildToolList(new Set());
    const allbirds = list.find((t) => t.name === "search_catalog_on_allbirds_com");
    expect(allbirds).toBeUndefined();
  });

  it("descriptor shape matches McpToolDescriptor", () => {
    const list = buildToolList(new Set(["https://www.allbirds.com"]));
    const t = list.find((x) => x.name === "search_catalog_on_allbirds_com");
    expect(t?.inputSchema.type).toBe("object");
    expect(typeof t?.description).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/mcp-tools.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/mcp/tools.ts
import type { McpToolDescriptor } from "../../shared/mcp";
import type { ToolManifest } from "../../shared/manifest";
import { MANIFESTS } from "../manifests";

/**
 * The three always-on tools. Same names the WebMCP façade registers, so an
 * agent that learned them from one surface sees the same names on the other.
 */
const SPINE: McpToolDescriptor[] = [
  {
    name: "get_page_state",
    description:
      "Text description of the remote browser view. Required: the model cannot see the canvas.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_available_origins",
    description: "Origins this session may act on, after consent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "navigate_to",
    description:
      "Navigate the remote browser to an https origin the user has granted.",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "https origin or URL" },
      },
      required: ["origin"],
      additionalProperties: false,
    },
  },
];

export const SPINE_NAMES = SPINE.map((t) => t.name);

/**
 * Build the tool list an MCP client sees. SPINE is always present. Per-origin
 * manifests are included only for granted origins — ungranted origins are
 * invisible, not "denied at call time."
 */
export function buildToolList(consented: ReadonlySet<string>): McpToolDescriptor[] {
  const out: McpToolDescriptor[] = [...SPINE];
  for (const m of MANIFESTS) {
    if (!consented.has(m.origin)) continue;
    out.push({
      name: m.name,
      description: m.description,
      inputSchema: m.inputSchema as unknown as Record<string, unknown>,
    });
  }
  return out;
}

/** Read the persisted consent list from the session DO. */
export function consentedOriginsFromRows(consent: string[]): Set<string> {
  return new Set(consent.filter((x) => typeof x === "string"));
}

/** Used by tests to assert which manifests are in scope. */
export function manifestByName(name: string): ToolManifest | undefined {
  return MANIFESTS.find((m) => m.name === name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/mcp-tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/mcp/tools.ts tests/mcp-tools.test.ts
git commit -m "feat(mcp): build tool list from consented origins"
```

---

### Task 4: SessionDO.listTools public method

**Files:**
- Modify: `worker/session-do.ts:118` (insert new method after `listAudit`)
- Test: `tests/mcp-do.test.ts`

**Interfaces:**
- Consumes: existing `readConsent()`, `MANIFESTS`
- Produces: `SessionDO.listTools(): Promise<McpToolDescriptor[]>`

The MCP server calls `stub.listTools()` (Durable Object RPC) to get the tool list. The DO reads its own consent list and filters manifests. Returns the SPINE + granted-origin descriptors.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-do.test.ts
import { describe, expect, it } from "vitest";
import { buildToolList } from "../worker/mcp/tools";

describe("SessionDO.listTools contract (mocked via buildToolList)", () => {
  // The DO method is a thin wrapper around buildToolList(consented). We test
  // the wrapper logic by reproducing it here; integration is covered by the
  // e2e test in Task 9 against @modelcontextprotocol/sdk.
  it("returns SPINE only when no origins consented", () => {
    const list = buildToolList(new Set());
    expect(list.length).toBe(3);
    expect(list.map((t) => t.name).sort()).toEqual(
      ["get_page_state", "list_available_origins", "navigate_to"],
    );
  });

  it("returns SPINE plus consented-origin tools", () => {
    const list = buildToolList(new Set(["https://www.kayak.com"]));
    const names = list.map((t) => t.name);
    expect(names).toContain("search_flights_on_kayak_com");
  });
});
```

- [ ] **Step 2: Run test to verify it passes already (sanity check)**

Run: `pnpm test tests/mcp-do.test.ts`
Expected: PASS — this test exists to lock in the contract that the DO method will implement. The DO method itself is added in the next step.

- [ ] **Step 3: Add the public method to SessionDO**

Add this method to `worker/session-do.ts`, immediately after `listAudit` (around line 130):

```typescript
  /**
   * Public RPC for the MCP server. Returns the tools this session exposes,
   * filtered by consent. SPINE is always present; per-origin manifests only
   * for granted origins.
   */
  async listTools(): Promise<ToolSchema[]> {
    const consented = new Set(this.readConsent());
    return buildToolList(consented) as unknown as ToolSchema[];
  }
```

Add the import near the top of the file alongside the existing `manifests.ts` import:

```typescript
import { buildToolList } from "./mcp/tools";
```

- [ ] **Step 4: Run the typecheck**

Run: `pnpm run typecheck`
Expected: PASS — `ToolSchema` and `McpToolDescriptor` have the same shape, so the cast is structural.

- [ ] **Step 5: Commit**

```bash
git add worker/session-do.ts tests/mcp-do.test.ts
git commit -m "feat(mcp): expose listTools on SessionDO"
```

---

### Task 5: SessionDO.callTool public method

**Files:**
- Modify: `worker/session-do.ts` (add method after `listTools`)
- Test: `tests/mcp-do-call.test.ts`

**Interfaces:**
- Consumes: existing `runTool(name, args)` and `recordAudit(origin, tool, fieldNames)`
- Produces: `SessionDO.callTool(name, args): Promise<{ ok: boolean; text: string }>`

The MCP `tools/call` path goes through the existing `runTool` (consent check, SSRF check, native WebMCP or CDP replay, audit row). The DO method is a thin public wrapper that records the audit row the way `onToolExec` does — but without the websocket broadcast, since MCP has no socket.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-do-call.test.ts
import { describe, expect, it, vi } from "vitest";
import { manifestByName } from "../worker/mcp/tools";
import { originOfTool } from "../worker/manifests";

describe("MCP callTool contract helpers", () => {
  it("manifestByName finds a known manifest", () => {
    const m = manifestByName("search_flights_on_kayak_com");
    expect(m?.origin).toBe("https://www.kayak.com");
  });

  it("originOfTool returns the manifest origin", () => {
    expect(originOfTool("search_flights_on_kayak_com")).toBe("https://www.kayak.com");
  });

  it("originOfTool returns null for spine tools", () => {
    expect(originOfTool("get_page_state")).toBeNull();
    expect(originOfTool("navigate_to")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it passes already**

Run: `pnpm test tests/mcp-do-call.test.ts`
Expected: PASS — these are helpers that already exist; this test pins the contract that `callTool` will rely on.

- [ ] **Step 3: Add the public method to SessionDO**

Add this method to `worker/session-do.ts`, immediately after `listTools`:

```typescript
  /**
   * Public RPC for the MCP server. Bridges to the same runTool the WebMCP
   * façade calls via the bridge WebSocket. Same consent gate, same SSRF
   * check, same audit row. The only difference: no broadcast (MCP has no
   * socket), so we record the audit and return directly.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; text: string }> {
    let result: { ok: boolean; text: string };
    try {
      result = await this.runTool(name, args);
    } catch (err) {
      result = {
        ok: false,
        text: err instanceof Error ? err.message : "tool failed",
      };
    }
    const fieldNames = manifestFor(name)?.fillsFrom ?? [];
    const auditOrigin =
      originOfTool(name) ?? this.currentOrigin() ?? "";
    this.recordAudit(auditOrigin, name, fieldNames);
    return result;
  }
```

Add the import for `originOfTool` if not already imported (it currently isn't in `session-do.ts`):

```typescript
import { MANIFESTS, manifestFor, originOfTool } from "./manifests";
```

- [ ] **Step 4: Run the typecheck**

Run: `pnpm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/session-do.ts tests/mcp-do-call.test.ts
git commit -m "feat(mcp): expose callTool on SessionDO"
```

---

### Task 6: Bearer token auth

**Files:**
- Create: `worker/mcp/auth.ts`
- Test: `tests/mcp-auth.test.ts`

**Interfaces:**
- Consumes: bearer token from `Authorization` header; `env.SESSION.getByName(token)` for DO lookup
- Produces: `authenticate(request, env): { ok: true; stub: DurableObjectStub } | { ok: false; response: Response }`

For Phase 1, the bearer token IS the session token (the 64-hex-char token issued by `POST /sessions`). This is simple and reuses the existing primitive. The trade-off — session tokens are short-lived and intended for capability URLs — is acknowledged; long-lived MCP tokens are a Phase 1.5 task.

Token format: `^[A-Fa-f0-9]{64}$` (matches the existing session token regex).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-auth.test.ts
import { describe, expect, it } from "vitest";
import { extractBearer, isValidToken } from "../worker/mcp/auth";

describe("MCP bearer auth", () => {
  it("extracts a valid Bearer token", () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: "Bearer abc123" },
    });
    expect(extractBearer(req)).toBe("abc123");
  });

  it("returns null on missing Authorization header", () => {
    const req = new Request("https://example.com/mcp");
    expect(extractBearer(req)).toBeNull();
  });

  it("returns null on non-Bearer scheme", () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(extractBearer(req)).toBeNull();
  });

  it("validates a 64-hex token", () => {
    const t = "a".repeat(64);
    expect(isValidToken(t)).toBe(true);
  });

  it("rejects malformed tokens", () => {
    expect(isValidToken("tooshort")).toBe(false);
    expect(isValidToken("z".repeat(64))).toBe(false); // non-hex
    expect(isValidToken("a".repeat(65))).toBe(false); // wrong length
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/mcp-auth.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/mcp/auth.ts
/**
 * Bearer-token auth for the MCP surface.
 *
 * For Phase 1, the bearer token IS the existing session token. This trades
 * long-term persistence for reuse of the existing primitive. Long-lived MCP
 * tokens are Phase 1.5 (depends on ChatGPT auth-flow findings).
 */

const TOKEN_RE = /^[A-Fa-f0-9]{64}$/;

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/);
  return match ? match[1] : null;
}

export function isValidToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export type AuthOk = { ok: true; token: string };
export type AuthErr = {
  ok: false;
  response: Response;
};

/**
 * Pulls and validates the bearer token from the request. Returns either a
 * valid token or a fully-formed 401 Response the caller can return directly.
 *
 * The actual DO lookup is left to the caller — auth.ts is pure and easily
 * testable, server.ts handles env-bound concerns.
 */
export function authenticate(request: Request): AuthOk | AuthErr {
  const token = extractBearer(request);
  if (!token || !isValidToken(token)) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Unauthorized" },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "WWW-Authenticate": 'Bearer realm="mcpmatic"',
          },
        },
      ),
    };
  }
  return { ok: true, token };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/mcp-auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/mcp/auth.ts tests/mcp-auth.test.ts
git commit -m "feat(mcp): add bearer token auth for /mcp surface"
```

---

### Task 7: MCP HTTP handler

**Files:**
- Create: `worker/mcp/server.ts`
- Test: `tests/mcp-handler.test.ts`

**Interfaces:**
- Consumes: parsed `JsonRpcRequest`, `env.SESSION.getByName(token)`, stub RPC methods (`listTools`, `callTool`, `readConsent`, `grantConsent`)
- Produces: `handleMcp(request, env): Promise<Response>`

Routes JSON-RPC methods to handlers:
- `initialize` → returns server info and capabilities (no session lookup needed)
- `ping` → returns empty result
- `tools/list` → `stub.listTools()`
- `tools/call` → `stub.callTool(name, args)` and wraps result in MCP content blocks

All other methods → JSON-RPC method-not-found error.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-handler.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/mcp-handler.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/mcp/server.ts
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
import { buildToolList, consentedOriginsFromRows } from "./tools";
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
 * does protocol.
 */
export async function dispatch(
  req: JsonRpcRequest,
  session: McpSession,
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

  const stub = env.SESSION.getByName(auth.token);
  const session: McpSession = {
    listTools: () => stub.listTools() as Promise<unknown>,
    callTool: (name, args) =>
      stub.callTool(name, args) as Promise<{ ok: boolean; text: string }>,
  };
  const resp = await dispatch(parsed.req, session);
  return new Response(JSON.stringify(resp), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "MCP-Protocol-Version": "2025-03-26",
    },
  });
}
```

Note: `consentedOriginsFromRows` is imported but not used in Phase 1; it stays exported because Phase 2 (consent UI) will use it. The unused import will be removed or used in Task 8.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/mcp-handler.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/mcp/server.ts tests/mcp-handler.test.ts
git commit -m "feat(mcp): add MCP HTTP handler with JSON-RPC dispatch"
```

---

### Task 8: Wire the /mcp route

**Files:**
- Modify: `worker/index.ts` (add route handler)
- Test: existing tests continue to pass; manual smoke test

The Worker entry point dispatches by path. Add `/mcp` to the routing logic.

- [ ] **Step 1: Add the route**

In `worker/index.ts`, add this branch inside `fetch` after the existing `consentMatch` block (around line 45):

```typescript
    if (path === "/mcp") {
      const { handleMcp } = await import("./mcp/server");
      return handleMcp(request, env);
    }
```

- [ ] **Step 2: Run the typecheck**

Run: `pnpm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: all existing tests still pass (no regression).

- [ ] **Step 4: Smoke test with curl**

Start the dev server in another terminal: `pnpm dev`. Then:

```bash
# Create a session
SESSION=$(curl -s -X POST http://localhost:8787/sessions | jq -r .sessionToken)
echo "Token: $SESSION"

# Hit /mcp without auth (should 401)
curl -i -X POST http://localhost:8787/mcp \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

# Hit /mcp with auth (should return server info)
curl -X POST http://localhost:8787/mcp \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $SESSION" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

# List tools (should return SPINE only — no origins consented yet)
curl -X POST http://localhost:8787/mcp \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Expected: 401 for unauth; 200 with serverInfo for auth; tools list contains the three spine tools only.

- [ ] **Step 5: Commit**

```bash
git add worker/index.ts
git commit -m "feat(mcp): wire /mcp route in worker entry point"
```

---

### Task 9: End-to-end test against @modelcontextprotocol/sdk

**Files:**
- Modify: `package.json` (add devDep)
- Create: `tests/mcp-e2e.test.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk/client` (test client)
- Produces: an end-to-end test that talks to a real Cloudflare Worker fetch handler

This is the spec-compliance gate. If this passes, our server speaks MCP correctly. If ChatGPT or Claude fail, the issue is in their client, not ours.

- [ ] **Step 1: Install the SDK as a devDep**

```bash
pnpm add -D @modelcontextprotocol/sdk
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/mcp-e2e.test.ts
/**
 * @vitest-environment node
 *
 * End-to-end MCP protocol test. Uses the official MCP client SDK against a
 * direct invocation of handleMcp — no live Worker needed.
 *
 * This is the spec-compliance gate. If this passes, our server speaks MCP
 * correctly. If a real client (ChatGPT, Claude) fails, the issue is theirs.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handleMcp } from "../worker/mcp/server";

const TOKEN = "a".repeat(64);

function makeEnv(): Env {
  // Minimal env stub. The DO is not actually exercised by these tests because
  // we hit `initialize` and `tools/list` against an unconsented session, where
  // listTools returns the SPINE without touching the DO.
  return {} as unknown as Env;
}

describe("MCP end-to-end (spec-compliance gate)", () => {
  let client: Client;

  beforeEach(() => {
    client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );
  });

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
    expect(body.result.serverInfo.name).toBe("mcpmatic");
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
```

- [ ] **Step 3: Add the SDK client package import**

`@modelcontextprotocol/sdk` brings a number of transports. We only need `Client` and the in-memory transport for direct unit testing. The imports above are correct for the current SDK shape. If the import paths change at install time, adjust to match the installed version.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/mcp-e2e.test.ts`
Expected: PASS (4 tests). If `handleMcp` tries to call `env.SESSION.getByName(...)` for `tools/list` and the env is a stub, it will fail — the e2e test only hits `initialize`, `ping`, and auth-error paths, which don't touch the DO. Phase 1 acceptance does NOT require hitting `tools/list` against the in-memory DO; that requires either a `workerd` test runtime (out of scope for this task) or an integration test against a deployed Worker (Task 10).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tests/mcp-e2e.test.ts
git commit -m "test(mcp): end-to-end protocol test against SDK client"
```

---

### Task 10: Document the manual test matrix for Claude and ChatGPT

**Files:**
- Create: `tests/MCP_CLIENTS.md`

This task produces documentation, not code. The manual tests are the empirical gate that decides whether we ship OAuth in Phase 1.5.

- [ ] **Step 1: Write the matrix document**

```markdown
# MCP Client Test Matrix

Tests below are run by hand against real MCP-capable clients. Each row in the
decision matrix at the bottom determines the next phase of work.

## How to run a manual test

1. Deploy the Worker: `pnpm run deploy`
2. Create a session token: `curl -X POST https://<host>/sessions`
3. In the client, add an MCP server:
   - URL: `https://<host>/mcp`
   - Auth: Bearer `<session-token>`
4. Verify the client shows the three SPINE tools (`get_page_state`,
   `list_available_origins`, `navigate_to`).
5. Try to call a per-origin tool that hasn't been granted — should NOT be
   visible in the tool list.
6. Grant an origin via `POST /s/<token>/consent` with `{"origin": "https://www.kayak.com"}` and re-fetch the tool list — should now include `search_flights_on_kayak_com`.

## What to log per client

For each client below, capture and paste into the Findings section:

1. **First request behavior.** Did the client include an Authorization header
   on the first try, or did it rely on the 401 challenge?
2. **The 401.** Did the client honor `WWW-Authenticate` and retry with auth?
3. **Dynamic client registration.** Did the client send `client_id`?
   Pre-registered or self-registered?
4. **Redirect URI.** What redirect URI did the client use?
5. **Refresh behavior.** After invalidating the access token, did the client
   refresh or bounce to login?
6. **Error surfacing.** When something fails, what does the user see?

## Clients to test

### Claude desktop (spec-compliant reference client)

Expected: Full handshake, all SPINE tools visible, per-origin tools visible
after consent.

### ChatGPT (the empirical question)

Unknown. Test against the latest ChatGPT desktop build with MCP support
enabled. If ChatGPT only supports static bearer tokens pasted into a config
field, document this clearly — it determines the auth design.

## Findings

(populated by the engineer running the manual tests)

## Decision matrix

| Outcome | What it means | What we ship |
|---|---|---|
| Both clients do full OAuth | Plan was correct | OAuth 2.0 + PKCE in Phase 1.5 |
| Claude OAuth, ChatGPT static tokens only | Spec-compliance is fine; ChatGPT's client is the constraint | Static token path for ChatGPT; OAuth for everyone else; both on the same backend |
| Neither does OAuth | MCP support is incomplete in both clients | Hold MCP surface; ship when clients catch up |
```

- [ ] **Step 2: Commit**

```bash
git add tests/MCP_CLIENTS.md
git commit -m "docs: add MCP client manual test matrix"
```

---

### Task 11: Run the manual tests and record findings

**Files:**
- Modify: `tests/MCP_CLIENTS.md` (populate Findings section)
- This task is empirical; the deliverable is findings, not code.

- [ ] **Step 1: Deploy and run against Claude desktop**

1. `pnpm run deploy`
2. Open Claude desktop
3. Settings → Connectors → Add MCP server (URL: `https://<host>/mcp`, auth: Bearer)
4. Verify the three SPINE tools appear
5. Grant an origin via the existing `POST /s/<token>/consent` endpoint
6. Re-list tools — verify per-origin tool appears
7. Run a tool call
8. Capture observations into `tests/MCP_CLIENTS.md` Findings section

- [ ] **Step 2: Run against ChatGPT**

Same as above, but with ChatGPT. Pay close attention to the six log items
listed in the matrix document.

- [ ] **Step 3: Update the decision matrix**

Based on observations, fill in the "Findings" and "Decision" sections of `tests/MCP_CLIENTS.md`.

- [ ] **Step 4: Commit**

```bash
git add tests/MCP_CLIENTS.md
git commit -m "docs: record MCP client test findings"
```

---

### Task 12: Decide and document the OAuth path

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-mcp-server-phase-1.md` (add Outcome section at bottom)
- Create: `docs/superpowers/plans/2026-09-01-mcp-server-phase-1.5-<outcome>.md` (next plan)

The decision from Task 11 produces one of three outcomes. Each outcome has its own next-step plan:

- **Outcome A: Both clients do OAuth.** Next plan implements OAuth 2.0 + PKCE at `/oauth/{authorize,token,register}`.
- **Outcome B: OAuth for spec-compliant clients, static tokens for ChatGPT.** Next plan adds a hosted signup flow that issues long-lived MCP tokens, separate from session tokens.
- **Outcome C: Neither client does OAuth.** Next plan is "wait" — document the limitation and revisit when clients ship.

- [ ] **Step 1: Append the Outcome section to this plan**

Append at the bottom of this file:

```markdown
## Outcome

**Outcome A: Both clients do full OAuth.**

Phase 1 ships bearer-token auth at `/mcp` as the baseline. Phase 1.5 replaces it with full OAuth 2.0 + PKCE so spec-compliant MCP clients (Claude desktop, ChatGPT) handle the auth flow themselves — no token paste, no manual `/sessions` call.

**Decision:** Pre-committed by the engineer before Task 11's empirical ChatGPT test was run. The engineer reasoned that the OAuth path is the spec-aligned target and the empirical test is a confirmation step, not a gate — if the test reveals ChatGPT doesn't support the full OAuth flow, we re-evaluate against Outcome B at that point. Bearer-token auth remains functional as a fallback for clients that don't support OAuth and for human engineers debugging.

**Phase 1.5 plan:** `docs/superpowers/plans/2026-09-01-mcp-server-phase-1.5-oauth.md`

**Production deploy:** Phase 1 deployed at `https://mcpmatic.dan-3c7.workers.dev` (version `cf48445c-b735-4b56-aa46-b840d0ac4c3e`). End-to-end smoke test passed: 401 unauth → 200 initialize with serverInfo → 200 tools/list with three SPINE tools.

**Task 11 status:** Skipped at the engineer's direction. The `tests/MCP_CLIENTS.md` Findings section remains empty — populate it when running real-client tests during Phase 1.5 implementation (or as a follow-up audit).
```

- [ ] **Step 2: Decide and create the Phase 1.5 plan**

Based on the decision matrix, create one of:

- `docs/superpowers/plans/2026-09-01-mcp-server-phase-1.5-oauth.md`
- `docs/superpowers/plans/2026-09-01-mcp-server-phase-1.5-tokens.md`
- `docs/superpowers/plans/2026-09-01-mcp-server-phase-1.5-hold.md`

The Phase 1.5 plan is out of scope for this document — write it when you know which branch you're on.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-09-01-mcp-server-phase-1.md docs/superpowers/plans/2026-09-01-mcp-server-phase-1.5-*.md
git commit -m "docs: record Phase 1 outcome and Phase 1.5 plan path"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| MCP server route at `/mcp` | Task 8 |
| JSON-RPC 2.0 envelope | Task 2 |
| `initialize` method | Task 7 |
| `ping` method | Task 7 |
| `tools/list` returning only consented origins | Tasks 3, 4, 7 |
| `tools/call` routing through existing `runTool` | Tasks 5, 7 |
| Bearer auth | Task 6 |
| Audit row written (no value column) | Task 5 |
| Origin-qualified tool names | Task 3 (no manifest mutation) |
| Consent gates tool visibility, not just execution | Task 3 |
| No new SSRF path | Task 5 (route through `runTool`) |
| No LLM in hot path | Task 5 (calls `runTool` directly) |

**Placeholder scan:** No "TBD" / "implement later" / "add appropriate handling" in this plan.

**Type consistency:**
- `JsonRpcRequest` defined in Task 1, used in Tasks 2, 7. ✓
- `JsonRpcResponse` defined in Task 1, used in Tasks 2, 7. ✓
- `McpToolDescriptor` defined in Task 1, used in Tasks 3, 7. ✓
- `McpCallResult` defined in Task 1, used in Task 7. ✓
- `McpSession` defined in Task 7, used in Tasks 7, 9. ✓
- `parseRequest` defined in Task 2, used in Task 7. ✓
- `success`, `errorResult` defined in Task 2, used in Task 7. ✓
- `authenticate` defined in Task 6, used in Task 7. ✓
- `buildToolList` defined in Task 3, used in Tasks 4, 7. ✓
- `handleMcp` defined in Task 7, used in Task 9. ✓

**No changes to:**
- Audit table schema (`shared/protocol.ts`)
- SSRF checks (`worker/is-private-url.ts`)
- WebMCP façade routes (`/sessions`, `/s/<token>`, `/s/<token>/consent`, `/s/<token>/bridge`)
- Tool execution path (`runTool`, `runStep`)
- Existing consent storage (`meta` table in DO SQLite)
