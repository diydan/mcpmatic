/**
 * Call a tool already registered on the *remote* page (e.g. Shopify's
 * search_catalog). The façade never reimplements those handlers.
 */
export async function callNativeTool(
  evaluate: (
    fn: (payload: { nativeName: string; args: Record<string, unknown> }) => Promise<{
      used: boolean;
      text?: string;
    }>,
    payload: { nativeName: string; args: Record<string, unknown> },
  ) => Promise<{ used: boolean; text?: string }>,
  nativeName: string,
  args: Record<string, unknown>,
): Promise<{ used: boolean; text?: string }> {
  try {
    return await evaluate(nativeCall, { nativeName, args });
  } catch {
    return { used: false };
  }
}

/** Serialized into the remote page by Playwright. Do not close over worker state. */
async function nativeCall(payload: {
  nativeName: string;
  args: Record<string, unknown>;
}): Promise<{ used: boolean; text?: string }> {
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
    return { used: false };
  }
  const tools = await mc.getTools();
  const tool = tools.find((t: { name: string }) => t.name === payload.nativeName);
  if (!tool) return { used: false };
  const result = await mc.executeTool(tool, payload.args);
  return {
    used: true,
    text: typeof result === "string" ? result : JSON.stringify(result),
  };
}

export function remoteNativeName(
  qualified: string,
  nativeName?: string,
): string | null {
  if (nativeName) return nativeName;
  const match = /^([a-z0-9_]+)_on_[a-z0-9_]+$/i.exec(qualified);
  return match ? match[1] : null;
}
