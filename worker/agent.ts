import type { ToolSchema } from "../shared/protocol";
import { checkArgs } from "./schema-check";

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
  /** Pins one model for every turn, outranking the easy/hard split. */
  OPENAI_MODEL?: string;
  /** Small and fast: picking one tool with flat arguments. */
  MODEL_EASY?: string;
  /** Larger: nested argument shapes, or a turn that is chaining. */
  MODEL_HARD?: string;
  AI_GATEWAY_ID?: string;
};

/**
 * Two models, chosen per turn.
 *
 * Picking one tool with flat arguments is an easy job and latency is what a
 * person watching a demo feels, so that runs on the small model. Two things
 * make a turn genuinely harder, and both are measurable before the call rather
 * than guessed:
 *
 *  - **A tool that nests its required fields.** Shopify's `update_cart` is
 *    `required: ["cart"]` wrapping `required: ["line_items"]`, and a weaker
 *    model flattens that to `{query}`. Verified against the live storefront;
 *    it is the exact case `checkArgs` was written to catch.
 *  - **A turn that is chaining rather than picking.** After two tool results
 *    the model is recovering or composing, not choosing from a menu.
 *
 * Structural signals only. Sniffing tool output for the word "failed" would
 * bind model choice to error prose, which changes.
 *
 * Both default to the same id because it is the one verified to resolve
 * through this account's AI Gateway. `openai/gpt-5.6-luna` and
 * `openai/gpt-5.6-sol` both return `7003: User Input Error`: Sol, Terra and
 * Luna are ChatGPT client tiers, not API models. Point `MODEL_HARD` at a
 * larger model that does resolve and the escalation below starts working.
 */
const DEFAULT_EASY = "openai/gpt-5.5";
const DEFAULT_HARD = "openai/gpt-5.5";
/** Chaining begins once this many tool results are already in the transcript. */
const CHAINING_AFTER = 2;

export function chooseModel(
  env: Pick<ModelEnv, "OPENAI_MODEL" | "MODEL_EASY" | "MODEL_HARD">,
  tools: readonly ToolSchema[],
  messages: readonly ChatTurn[],
): string {
  // An explicit single-model override outranks routing, so pinning a model
  // for a test or a demo stays one setting.
  if (env.OPENAI_MODEL) return env.OPENAI_MODEL;

  const easy = env.MODEL_EASY || DEFAULT_EASY;
  const hard = env.MODEL_HARD;
  // No hard model configured means one model, as before.
  if (!hard && !env.MODEL_EASY) {
    return needsHardModel(tools, messages) ? DEFAULT_HARD : DEFAULT_EASY;
  }
  if (!hard) return easy;
  return needsHardModel(tools, messages) ? hard : easy;
}

function needsHardModel(
  _tools: readonly ToolSchema[],
  messages: readonly ChatTurn[],
): boolean {
  // Only chaining is knowable before the call. "Does any offered tool nest"
  // looked useful and is not: with a catalog granted, 4 of 16 tools nest, so
  // it fires on every turn and the small model is never used. The model picks
  // one tool, and which one it picks is the thing we cannot know in advance —
  // so nesting is judged after the fact, in runTurn.
  return messages.filter((m) => m.role === "tool").length >= CHAINING_AFTER;
}



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
  const first = await callModel(env, chooseModel(env, tools, messages), messages, tools);
  // Escalate only on evidence. If the small model produced arguments the
  // tool's own schema rejects, the larger one gets one attempt at the same
  // turn. Retrying at most once keeps a bad turn from costing three calls.
  const hard = env.MODEL_HARD;
  if (!hard || env.OPENAI_MODEL || argumentsFit(first, tools)) return first;
  return callModel(env, hard, messages, tools);
}

/** Did the model's tool call satisfy the schema that tool declares? */
function argumentsFit(decision: AgentDecision, tools: readonly ToolSchema[]): boolean {
  if (decision.kind !== "tool") return true; // a plain reply has nothing to get wrong
  const tool = tools.find((t) => t.name === decision.name);
  if (!tool) return true; // an unknown tool name is a different failure
  return checkArgs(tool.inputSchema, decision.arguments).ok;
}

async function callModel(
  env: ModelEnv,
  model: string,
  messages: ChatTurn[],
  tools: ToolSchema[],
): Promise<AgentDecision> {

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
