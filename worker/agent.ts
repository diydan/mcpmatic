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
 * Luna is the cost-optimised member of the gpt-5.6 family and Sol the frontier
 * one, both with a 1,050,000 token context. They speak the Responses API, not
 * Chat Completions; see isResponsesModel.
 */
const DEFAULT_EASY = "openai/gpt-5.6-luna";
const DEFAULT_HARD = "openai/gpt-5.6-sol";
/** Chaining begins once this many tool results are already in the transcript. */
const CHAINING_AFTER = 2;

/**
 * The gpt-5.6 family takes the Responses API, not Chat Completions.
 *
 * Cloudflare's model pages list "Request formats: Responses" for luna, sol and
 * terra. Sending a Chat Completions body to them returns
 * `7003: User Input Error`, which is accurate and easy to misread as the model
 * not existing. They exist, and they carry a 1,050,000 token context window.
 */
export function isResponsesModel(model: string): boolean {
  return /(^|\/)gpt-5\.6(-|$)/.test(model);
}

/**
 * A Responses request.
 *
 * Three differences from chat that matter: the system prompt is `instructions`
 * rather than a message, a tool declaration is flat rather than nested under
 * `function`, and a tool result is a `function_call_output` item rather than a
 * message with a role.
 */
export function responsesBody(
  messages: readonly ChatTurn[],
  tools: readonly ToolSchema[],
): Record<string, unknown> {
  const instructions = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content ?? "")
    .join("\n");
  const input: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id ?? "",
        output: m.content ?? "",
      });
      continue;
    }
    // An assistant turn that called tools has to reach the Responses API as
    // `function_call` items. Flattened to a bare role/content pair the calls
    // are lost, and the `function_call_output` that follows then references a
    // call_id nothing in the input declared — which the API rejects outright
    // ("7003: User Input Error"), stranding the user mid-task with the page
    // already navigated. Latent until the prompt began requiring a tool call
    // on every turn; now it is the first thing every task does.
    if (m.role === "assistant" && m.tool_calls?.length) {
      // Only when the model actually spoke as well as called.
      if (m.content) input.push({ role: m.role, content: m.content });
      for (const call of m.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    input.push({ role: m.role, content: m.content ?? "" });
  }
  return {
    instructions,
    input,
    // A ceiling, not a target: a short chat reply costs nothing extra for it
    // being high. At 1024 it was low enough to truncate a generated manifest
    // mid-object — a JSON array of tools, each with a name, description,
    // inputSchema and steps, does not fit. The model was doing its job and
    // the budget threw the answer away, reported as "not valid JSON".
    // Observed on news.ycombinator.com, cut off inside the first tool's
    // first step.
    max_output_tokens: 8192,
    // Omitted entirely when empty rather than sent as `tools: []`.
    // OpenAI-compatible endpoints have historically rejected an empty array
    // with `Invalid 'tools': empty array`, and manifest generation is the
    // first caller that passes one — every other caller sends the non-empty
    // SPINE list. The tests stub `env.AI.run` and never read the body, so if
    // the gateway forwards it verbatim, generation fails in production while
    // every test still passes. Costs nothing if the endpoint would have
    // accepted it.
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        }
      : {}),
  };
}

/**
 * Read a decision out of a Responses payload.
 *
 * `output` is a list of items rather than a single message. A turn can both
 * speak and call a tool; the call is what moves the session, so it wins.
 */
export function decideResponses(raw: unknown): AgentDecision {
  const output = (raw as { output?: unknown })?.output;
  if (!output && (raw as { choices?: unknown })?.choices) {
    return decide(raw);
  }
  const items = Array.isArray(output) ? output : [];

  for (const item of items) {
    const it = item as { type?: string; name?: string; call_id?: string; id?: string; arguments?: unknown };
    if (it.type !== "function_call" || typeof it.name !== "string") continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(typeof it.arguments === "string" ? it.arguments : "{}");
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      /* a model that emits invalid JSON gets an empty object, not a crash */
    }
    return { kind: "tool", id: it.call_id || it.id || "", name: it.name, arguments: args };
  }

  const text = items
    .filter((i) => (i as { type?: string }).type === "message")
    .flatMap((i) => ((i as { content?: unknown[] }).content ?? []) as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");

  return { kind: "message", content: text || "The model returned no output." };
}

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

You may navigate to any https site you judge relevant to the task. You are not limited to sites that already have tools.
Your first tool call on a new task is always navigate_to, so the user sees a live page as early as possible.
Search engines block automated browsers. Google serves this browser a CAPTCHA, which you may not work around, and the task dead-ends there. Go directly to a site that would carry the answer — a retailer, an airline, a council, a listings site — rather than searching for one. If you genuinely do not know a suitable site, say so and ask.

A site with no registered tools is normal. inspect_site shows what the page exposes, read-only. Call list_remote_tools to find out whether the site publishes WebMCP tools of its own — on a site that publishes none, that call is what starts synthesising draft tools for it. A human approves each generated tool by name before any of them can run, and you may tell the user that — it is how this works, not something to hide. Never claim you proposed or created a tool; report the tool you actually called and what it returned.

Some origins are pre-wired and register tools as soon as they are granted — for example Allbirds and Brooklinen (Shopify: search_catalog, update_cart, proceed_to_checkout) and Kayak (search_flights_on_kayak_com, synthesised). These are examples of pre-wired sites, not the list of sites you may visit.

Prefer origin-qualified tools for the origin you are on. Never invent tools.
fill_checkout sends only the shopper's declared profile fields.
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
    // Omitted when empty for the same reason as responsesBody: an empty
    // array is rejected by some OpenAI-compatible endpoints, and manifest
    // generation is the only caller that sends one.
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          })),
        }
      : {}),
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
  const model = chooseModel(env, tools, messages);
  // The model a turn escalates away from, and so the one it can fall back to.
  const fallback = env.OPENAI_MODEL || env.MODEL_EASY || DEFAULT_EASY;
  let first: AgentDecision;
  try {
    first = await callModel(env, model, messages, tools);
  } catch (err) {
    // A model the account cannot call must cost a weaker answer, not the
    // whole task. Production died exactly here: three tool calls spent, Kayak
    // open on screen, and the turn abandoned on a provider credentials error
    // for the escalated model. A turn that never escalated has nowhere to
    // degrade to, so it fails as before rather than retrying itself.
    if (model === fallback) throw err;
    return callModel(env, fallback, messages, tools);
  }
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

/**
 * Every failure out of here names the model that produced it.
 *
 * Providers answer with bare codes — "2018: Invalid User Credentials" — and
 * that string reached the transcript unqualified. It identified neither the
 * model nor the call site, and a turn can involve two models plus an
 * asynchronous manifest generation, so narrowing it took three production
 * runs and a wrong hypothesis. The provider's own words are kept; the model
 * is prepended so the next one takes a single run.
 */
async function callModel(
  env: ModelEnv,
  model: string,
  messages: ChatTurn[],
  tools: ToolSchema[],
): Promise<AgentDecision> {
  try {
    return await callModelOnce(env, model, messages, tools);
  } catch (err) {
    throw new Error(
      `${model}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function callModelOnce(
  env: ModelEnv,
  model: string,
  messages: ChatTurn[],
  tools: ToolSchema[],
): Promise<AgentDecision> {

  if (env.AI) {
    // The binding takes `{author}/{model}`; the model goes in the first
    // argument, not the body.
    const qualified = model.includes("/") ? model : `openai/${model}`;
    const responses = isResponsesModel(qualified);
    // A gateway is a deployment choice, not a default. Sending every call
    // through one named "default" is not the binding's documented usage, and
    // it is not harmless: a gateway carries its own provider keys and its own
    // allowed-model list. Ours permitted `openai/gpt-5.6-luna` and refused
    // `openai/gpt-5.6-sol`, so a live task ran three tool calls, navigated,
    // and then died on "2018: Invalid User Credentials" — an error about a
    // gateway nobody had chosen, on an account with nothing wrong with it.
    // Named in AI_GATEWAY_ID, honoured; absent, the binding routes itself.
    const raw = await env.AI.run(
      qualified,
      responses ? responsesBody(messages, tools) : requestBody("", messages, tools),
      env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined,
    );
    return responses ? decideResponses(raw) : decide(raw);
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
