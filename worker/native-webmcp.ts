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
