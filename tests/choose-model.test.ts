import { describe, expect, it } from "vitest";
import { chooseModel, runTurn } from "../worker/agent";

const flat = [
  { name: "search", description: "d", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
];
// Shopify's real shape: required:["cart"] wrapping required:["line_items"].
const nested = [
  {
    name: "update_cart",
    description: "d",
    inputSchema: {
      type: "object",
      required: ["cart"],
      properties: {
        cart: { type: "object", required: ["line_items"], properties: { line_items: { type: "array" } } },
      },
    },
  },
];
const firstTurn = [
  { role: "system" as const, content: "s" },
  { role: "user" as const, content: "search for wool" },
];
const afterTwoTools = [
  ...firstTurn,
  { role: "tool" as const, content: "ran search" },
  { role: "tool" as const, content: "ran get_product" },
];

describe("chooseModel", () => {
  it("uses the easy model for a flat schema on a first turn", () => {
    expect(chooseModel({ MODEL_EASY: "easy", MODEL_HARD: "hard" }, flat, firstTurn)).toBe("easy");
  });

  it("does not escalate merely because some offered tool nests", () => {
    // It looked like a useful signal and is not: with a catalog granted, 4 of
    // 16 tools nest, so it fires on every turn and the small model is never
    // used. The model calls one tool, and nesting is judged on what it
    // actually produced. See the escalation tests below.
    expect(chooseModel({ MODEL_EASY: "easy", MODEL_HARD: "hard" }, nested, firstTurn)).toBe("easy");
  });

  it("escalates once the turn is chaining rather than picking", () => {
    expect(chooseModel({ MODEL_EASY: "easy", MODEL_HARD: "hard" }, flat, afterTwoTools)).toBe("hard");
  });

  it("never escalates when no hard model is configured", () => {
    // Back-compat: one model stays one model.
    expect(chooseModel({ MODEL_EASY: "easy" }, nested, afterTwoTools)).toBe("easy");
  });

  it("an explicit single-model override wins outright", () => {
    expect(
      chooseModel({ OPENAI_MODEL: "pinned", MODEL_EASY: "easy", MODEL_HARD: "hard" }, nested, afterTwoTools),
    ).toBe("pinned");
  });

  it("falls back to the shipped default, the id verified to resolve", () => {
    // openai/gpt-5.6-luna and -sol both return 7003 through AI Gateway: Sol,
    // Terra and Luna are ChatGPT client tiers, not API models. Until
    // MODEL_HARD names a bigger model that resolves, both paths are the same.
    expect(chooseModel({}, flat, firstTurn)).toBe("openai/gpt-5.5");
    expect(chooseModel({}, flat, afterTwoTools)).toBe("openai/gpt-5.5");
  });

  it("does not choke on a schema it cannot read", () => {
    const odd = [{ name: "x", description: "d", inputSchema: { type: "object" } }];
    expect(chooseModel({ MODEL_EASY: "easy", MODEL_HARD: "hard" }, odd, firstTurn)).toBe("easy");
  });
});

describe("escalation on evidence, not on the tool menu", () => {
  const nestedTools = nested;

  function fakeAi(...replies: unknown[]) {
    const calls: string[] = [];
    let i = 0;
    return {
      calls,
      env: {
        MODEL_EASY: "t/easy",
        MODEL_HARD: "t/hard",
        AI: {
          run: async (model: string) => {
            calls.push(model);
            return replies[Math.min(i++, replies.length - 1)];
          },
        },
      },
    };
  }
  const toolCall = (args: string) => ({
    choices: [
      {
        message: {
          tool_calls: [
            { id: "c1", type: "function", function: { name: "update_cart", arguments: args } },
          ],
        },
      },
    ],
  });
  const plainReply = { choices: [{ message: { content: "hello" } }] };

  it("stays on the easy model when its arguments satisfy the schema", async () => {
    const { env, calls } = fakeAi(toolCall('{"cart":{"line_items":[{"handle":"x"}]}}'));
    await runTurn(env as never, firstTurn, nestedTools as never);
    expect(calls).toEqual(["t/easy"]);
  });

  it("retries on the hard model when the easy one gets the shape wrong", async () => {
    // The observed failure: a weaker model flattens cart.line_items to {query}.
    const { env, calls } = fakeAi(
      toolCall('{"query":"wool"}'),
      toolCall('{"cart":{"line_items":[{"handle":"x"}]}}'),
    );
    await runTurn(env as never, firstTurn, nestedTools as never);
    expect(calls).toEqual(["t/easy", "t/hard"]);
  });

  it("does not retry a turn that called no tool at all", async () => {
    const { env, calls } = fakeAi(plainReply);
    await runTurn(env as never, firstTurn, nestedTools as never);
    expect(calls).toEqual(["t/easy"]);
  });

  it("retries at most once, so a bad turn cannot cost three calls", async () => {
    const { env, calls } = fakeAi(toolCall('{"query":"wool"}'), toolCall('{"query":"wool"}'));
    await runTurn(env as never, firstTurn, nestedTools as never);
    expect(calls).toEqual(["t/easy", "t/hard"]);
  });

  it("does not retry when no hard model is configured", async () => {
    const calls: string[] = [];
    const env = {
      MODEL_EASY: "t/easy",
      AI: { run: async (m: string) => { calls.push(m); return toolCall('{"query":"wool"}'); } },
    };
    await runTurn(env as never, firstTurn, nestedTools as never);
    expect(calls).toEqual(["t/easy"]);
  });
});
