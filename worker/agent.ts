import type { ToolSchema } from "../shared/protocol";

export type ChatTurn = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type AgentDecision =
  | { kind: "message"; content: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };

/**
 * Two ways to reach a model, same request and response shape either way:
 *
 *  - `env.AI` — Cloudflare's AI binding, third-party model through AI Gateway.
 *    Cloudflare holds the provider credentials (Unified Billing), so there is
 *    no OpenAI key anywhere in this Worker. Preferred.
 *  - `env.OPENAI_API_KEY` — a direct call to api.openai.com. Fallback, for a
 *    deploy with no AI binding or no gateway credits.
 *
 * Either way the key never reaches the page (SPEC 2.2).
 */
export type ModelEnv = {
  AI?: {
    run: (
      model: string,
      input: Record<string, unknown>,
      options?: { gateway?: { id: string } },
    ) => Promise<unknown>;
  };
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  AI_GATEWAY_ID?: string;
};

const DEFAULT_MODEL = "openai/gpt-5.5";

const SYSTEM = `You operate websites through WebMCP tools registered on this page.
You cannot see the remote pixels. Call get_page_state when you need to know what is on screen.
Shopify stores (Allbirds, Brooklinen) already have native search_catalog, update_cart, proceed_to_checkout — use the origin-qualified names. fill_checkout sends only the shopper's declared profile fields.
Kayak has no WebMCP; search_flights_on_kayak_com is synthesised.
Prefer origin-qualified tools the user has granted. Never invent tools.
Keep replies short. After a tool runs, tell the user what changed.`;

export function initialMessages(user: string): ChatTurn[] {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

/** Which path (if any) this deployment can use. */
export function modelPath(env: ModelEnv): "binding" | "openai" | "none" {
  if (env.AI) return "binding";
  if (env.OPENAI_API_KEY) return "openai";
  return "none";
}

export function noModelMessage(): string {
  return "No model is configured on the worker: add an `ai` binding (no API key needed) or set OPENAI_API_KEY. The in-page agent cannot run. ChatGPT can still call the registered tools.";
}

function requestBody(
  model: string,
  messages: ChatTurn[],
  tools: ToolSchema[],
): Record<string, unknown> {
  return {
    messages,
    tools: tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    })),
    ...(model ? { model } : {}),
  };
}

type Completion = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
};

/** AI Gateway returns the OpenAI chat-completions shape, so one parser serves both. */
export function decide(raw: unknown): AgentDecision {
  const msg = (raw as Completion)?.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0];
  if (call) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<
        string,
        unknown
      >;
    } catch {
      args = {};
    }
    return {
      kind: "tool",
      id: call.id,
      name: call.function.name,
      arguments: args,
    };
  }
  return { kind: "message", content: msg?.content?.trim() || "(no reply)" };
}

export async function runTurn(
  env: ModelEnv,
  messages: ChatTurn[],
  tools: ToolSchema[],
): Promise<AgentDecision> {
  const model = env.OPENAI_MODEL || DEFAULT_MODEL;

  if (env.AI) {
    // The binding takes `{author}/{model}`; the model goes in the first
    // argument, not the body.
    const qualified = model.includes("/") ? model : `openai/${model}`;
    const raw = await env.AI.run(
      qualified,
      requestBody("", messages, tools),
      { gateway: { id: env.AI_GATEWAY_ID || "default" } },
    );
    return decide(raw);
  }

  if (!env.OPENAI_API_KEY) throw new Error(noModelMessage());

  // api.openai.com wants a bare model id.
  const bare = model.startsWith("openai/") ? model.slice("openai/".length) : model;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody(bare, messages, tools)),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
  }

  return decide(await res.json());
}

export function appendToolResult(
  messages: ChatTurn[],
  toolCallId: string,
  result: string,
): ChatTurn[] {
  return [...messages, { role: "tool", tool_call_id: toolCallId, content: result }];
}
