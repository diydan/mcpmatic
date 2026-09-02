/**
 * Call a tool already registered on the *remote* page (e.g. Shopify's
 * search_catalog). The façade never reimplements those handlers.
 */
export type NativeOutcome = {
  used: boolean;
  text?: string;
  /** Why the native tool was not used. Absent when `used` is true. */
  reason?: "no-webmcp" | "no-tool" | "threw";
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
): Promise<NativeOutcome> {
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
    polyfilled: !!(globalThis as { __mcpmaticPolyfilledWebMCP?: boolean })
      .__mcpmaticPolyfilledWebMCP,
  };
}


export type DiscoveredTool = { name: string; description: string };
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
    return await discover(nativeList);
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
  type Mc = { getTools: () => Promise<Array<{ name: string; description?: string }>> };
  const read = (): Mc | undefined =>
    (globalThis as { document?: { modelContext?: Mc } }).document?.modelContext;

  // We inject the API ourselves, so `modelContext` exists from the first tick
  // and its presence says nothing about whether the site has registered yet.
  // Wait for a tool to actually appear; an empty list after the deadline is a
  // real answer, not a timing artefact.
  const deadline = Date.now() + 8000;
  let mc = read();
  let raw: Array<{ name: string; description?: string }> = [];
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
  // A remote description is text we did not write, on its way into somebody
  // else's model context. Cap it and strip control characters before it
  // travels any further. This is the cheap half of the screening the registry
  // spec calls for; it is not a substitute for it.
  const clean = (v: unknown) =>
    String(v ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 200);
  return {
    ok: true,
    polyfilled: !!(globalThis as { __mcpmaticPolyfilledWebMCP?: boolean })
      .__mcpmaticPolyfilledWebMCP,
    tools: raw.slice(0, 40).map((t) => ({
      name: clean(t.name),
      description: clean(t.description),
    })),
  };
}
