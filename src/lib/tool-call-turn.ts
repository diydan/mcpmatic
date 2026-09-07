/**
 * One model-requested tool call, answered exactly once.
 *
 * The worker broadcasts `tool_call`, sets `pending.waitingId`, and stops: the
 * agent turn cannot advance until the page replies with a `tool_result`
 * carrying that same id. `shared/protocol.ts` states it plainly — "The page
 * sends exactly one of these per `tool_call` it receives, on every exit path."
 *
 * So this function never throws and never returns early. A missing tool, a
 * tool that fails, a page with no modelContext at all: each produces a result
 * the turn can consume. A silent return here is the hang it exists to prevent.
 *
 * Pure, taking the host as an argument, so the behaviour is testable without
 * rendering React — the same reason `shared/consent-ux.ts` and
 * `src/lib/render-fallback.ts` are shaped this way.
 */

export type ToolCallRequest = {
  /** The model's own tool-call id. The turn resumes on this, not on a UUID. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResultPayload = {
  callId: string;
  ok: boolean;
  result: string;
};

/** The slice of the page's modelContext this needs. */
export type ToolHost = {
  getTools: () => Promise<Array<{ name: string }>>;
  executeTool: (
    tool: { name: string },
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : "tool failed";
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export async function runToolCall(
  req: ToolCallRequest,
  host: ToolHost,
): Promise<ToolResultPayload> {
  try {
    const listed = await host.getTools();
    const tool = listed.find((t) => t.name === req.name);
    if (!tool) {
      return {
        callId: req.id,
        ok: false,
        result: `tool ${req.name} is not registered on this page`,
      };
    }
    return {
      callId: req.id,
      ok: true,
      result: asText(await host.executeTool(tool, req.arguments)),
    };
  } catch (err) {
    return { callId: req.id, ok: false, result: message(err) };
  }
}
