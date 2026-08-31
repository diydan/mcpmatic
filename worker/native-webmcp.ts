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

/** Serialized into the remote page by Playwright. Do not close over worker state. */
async function nativeCall(payload: {
  nativeName: string;
  args: Record<string, unknown>;
}): Promise<NativeOutcome> {
  const doc = (globalThis as {
    document?: {
      modelContext?: {
        getTools: () => Promise<Array<{ name: string }>>;
        executeTool: (tool: { name: string }, input?: object) => Promise<string>;
      };
    };
  }).document;
  const mc = doc?.modelContext;
  if (typeof mc?.getTools !== "function" || typeof mc.executeTool !== "function") {
    return { used: false, reason: "no-webmcp" };
  }
  const tools = await mc.getTools();
  const tool = tools.find((t: { name: string }) => t.name === payload.nativeName);
  if (!tool) return { used: false, reason: "no-tool" };
  // A tool that exists and throws is a different fact from a tool that is not
  // there. Collapsing them sends the operator debugging the wrong thing.
  let result: string;
  try {
    result = await mc.executeTool(tool, payload.args);
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
  };
}
