import type { DiscoveredTool } from "../shared/protocol";
import { checkArgs, type SchemaCheck } from "./schema-check";

export type { DiscoveredTool };

/**
 * Call a tool already registered on the *remote* page (e.g. Shopify's
 * search_catalog). The façade never reimplements those handlers.
 */
export type NativeOutcome = {
  used: boolean;
  text?: string;
  /** Why the native tool was not used. Absent when `used` is true. */
  reason?: "no-webmcp" | "no-tool" | "threw" | "schema-mismatch";
  /** Message from the remote tool when it threw. Never an argument value. */
  error?: string;
  /** True when the remote browser had no WebMCP and we supplied the API. */
  polyfilled?: boolean;
};

export type EvaluateFn = (
  fn: (payload: {
    nativeName: string;
    args: Record<string, unknown>;
  }) => Promise<NativeOutcome>,
  payload: { nativeName: string; args: Record<string, unknown> },
) => Promise<NativeOutcome>;

export async function callNativeTool(
  evaluate: EvaluateFn,
  nativeName: string,
  args: Record<string, unknown>,
  /**
   * The tool's own declared schema, as observed on the page. When present, a
   * call that cannot satisfy it is classified rather than sent: the remote
   * tool would throw, and "threw" loses the only fact a site owner can act on.
   * Absent means we do not know, and we call through rather than invent a
   * failure.
   */
  declaredSchema?: unknown,
): Promise<NativeOutcome> {
  const check = checkArgs(declaredSchema, args);
  if (!check.ok) {
    return {
      used: false,
      reason: "schema-mismatch",
      // Field names only. A value has no more business here than in the audit
      // table.
      error: describeMismatch(check),
    };
  }
  try {
    return await evaluate(nativeCall, { nativeName, args });
  } catch (err) {
    // The evaluate itself failed — navigation mid-call, page closed, CSP.
    return {
      used: false,
      reason: "threw",
      error: err instanceof Error ? err.message : "evaluate failed",
    };
  }
}

/**
 * Serialized into the remote page by Playwright. Do not close over worker state.
 *
 * Polls rather than reading once: we navigate with `waitUntil: "domcontentloaded"`,
 * and a storefront registers its tools from a script that has not run by then.
 * Reading immediately reported "no WebMCP" for sites that plainly have it.
 */
async function nativeCall(payload: {
  nativeName: string;
  args: Record<string, unknown>;
}): Promise<NativeOutcome> {
  type Mc = {
    getTools: () => Promise<Array<{ name: string }>>;
    executeTool: (tool: { name: string }, input?: object) => Promise<string>;
  };
  const read = (): Mc | undefined =>
    (globalThis as { document?: { modelContext?: Mc } }).document?.modelContext;
  const ready = (mc?: Mc) =>
    typeof mc?.getTools === "function" && typeof mc.executeTool === "function";

  const deadline = Date.now() + 8000;
  let mc = read();
  while (!ready(mc) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    mc = read();
  }
  if (!ready(mc)) return { used: false, reason: "no-webmcp" };

  // The context can appear before every tool is registered on it.
  let tool: { name: string } | undefined;
  while (!tool && Date.now() < deadline) {
    const tools = await mc!.getTools();
    tool = tools.find((t: { name: string }) => t.name === payload.nativeName);
    if (tool) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!tool) return { used: false, reason: "no-tool" };
  // A tool that exists and throws is a different fact from a tool that is not
  // there. Collapsing them sends the operator debugging the wrong thing.
  let result: string;
  try {
    result = await mc!.executeTool(tool, payload.args);
  } catch (err) {
    return {
      used: false,
      reason: "threw",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    used: true,
    text: typeof result === "string" ? result : JSON.stringify(result),
    polyfilled: !!(globalThis as { __browsermaticPolyfilledWebMCP?: boolean })
      .__browsermaticPolyfilledWebMCP,
  };
}

function describeMismatch(check: Extract<SchemaCheck, { ok: false }>): string {
  const parts: string[] = [];
  if (check.missing.length) parts.push(`missing ${check.missing.join(", ")}`);
  if (check.wrongType.length) parts.push(`wrong type for ${check.wrongType.join(", ")}`);
  if (check.unexpected.length) parts.push(`not in schema: ${check.unexpected.join(", ")}`);
  return parts.join("; ");
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const EMPTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
};

function cleanText(v: unknown, max = 200): string {
  return String(v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, max);
}

function sanitizeSchema(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_SCHEMA };
  try {
    const json = JSON.stringify(raw);
    if (json.length > 8000) return { ...EMPTY_SCHEMA };
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { ...EMPTY_SCHEMA };
  }
}

/** Strip control chars, drop illegal names, keep a JSON schema ChatGPT can call with. */
export function sanitizeDiscoveredTools(raw: unknown): DiscoveredTool[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoveredTool[] = [];
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { name?: unknown; description?: unknown; inputSchema?: unknown };
    const name = cleanText(rec.name, 128).trim();
    if (!NAME_RE.test(name)) continue;
    out.push({
      name,
      description: cleanText(rec.description),
      inputSchema: sanitizeSchema(rec.inputSchema),
    });
  }
  return out;
}

export type CallRemoteArgs =
  | {
      ok: true;
      name: string;
      arguments: Record<string, unknown>;
      origin: string | null;
    }
  | { ok: false; text: string };

export function parseCallRemoteArgs(
  args: Record<string, unknown>,
): CallRemoteArgs {
  const name = typeof args.name === "string" ? args.name : "";
  if (!NAME_RE.test(name)) {
    return { ok: false, text: "invalid native tool name" };
  }
  const raw = args.arguments;
  const callArgs =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const origin = typeof args.origin === "string" ? args.origin : null;
  return { ok: true, name, arguments: callArgs, origin };
}
export type DiscoveryOutcome = {
  ok: boolean;
  tools?: DiscoveredTool[];
  reason?: "no-webmcp" | "threw";
  error?: string;
  /** True when the API was supplied by this session rather than the browser. */
  polyfilled?: boolean;
};

export type DiscoverFn = (
  fn: () => Promise<DiscoveryOutcome>,
) => Promise<DiscoveryOutcome>;

/**
 * List the WebMCP tools the *remote* page exposes, without calling any of them.
 *
 * Read-only on purpose. It is how a session can say "this site exposes ten
 * tools" for an origin we hold no manifest for — the observed half of what the
 * registry does offline.
 */
export async function discoverNativeTools(
  discover: DiscoverFn,
): Promise<DiscoveryOutcome> {
  try {
    const out = await discover(nativeList);
    if (!out.ok) return out;
    return { ...out, tools: sanitizeDiscoveredTools(out.tools ?? []) };
  } catch (err) {
    return {
      ok: false,
      reason: "threw",
      error: err instanceof Error ? err.message : "evaluate failed",
    };
  }
}

/** Serialized into the remote page. Do not close over worker state. */
async function nativeList(): Promise<DiscoveryOutcome> {
  type Mc = {
    getTools: () => Promise<
      Array<{ name: string; description?: string; inputSchema?: unknown }>
    >;
  };
  const read = (): Mc | undefined =>
    (globalThis as { document?: { modelContext?: Mc } }).document?.modelContext;

  // We inject the API ourselves, so `modelContext` exists from the first tick
  // and its presence says nothing about whether the site has registered yet.
  // Wait for a tool to actually appear; an empty list after the deadline is a
  // real answer, not a timing artefact.
  const deadline = Date.now() + 8000;
  let mc = read();
  let raw: Array<{ name: string; description?: string; inputSchema?: unknown }> =
    [];
  for (;;) {
    mc = read();
    if (typeof mc?.getTools === "function") {
      raw = await mc.getTools();
      if (raw.length > 0) break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (typeof mc?.getTools !== "function") return { ok: false, reason: "no-webmcp" };
  // Do not call worker helpers from this function — Playwright serializes it
  // into the remote page. Sanitise on the worker after evaluate returns.
  return {
    ok: true,
    polyfilled: !!(globalThis as { __browsermaticPolyfilledWebMCP?: boolean })
      .__browsermaticPolyfilledWebMCP,
    tools: raw.map((t) => ({
      name: String(t.name ?? ""),
      description: String(t.description ?? ""),
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    })),
  };
}
