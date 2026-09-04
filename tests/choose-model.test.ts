import { describe, expect, it } from "vitest";
import { chooseModel } from "../worker/agent";

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

  it("escalates when a tool nests its required fields", () => {
    // The failure this exists for: a weaker model flattens cart.line_items to
    // {query}, which the site then rejects.
    expect(chooseModel({ MODEL_EASY: "easy", MODEL_HARD: "hard" }, nested, firstTurn)).toBe("hard");
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

  it("falls back to the shipped defaults when nothing is set", () => {
    expect(chooseModel({}, flat, firstTurn)).toBe("openai/gpt-5.6-luna");
    expect(chooseModel({}, nested, firstTurn)).toBe("openai/gpt-5.6-sol");
  });

  it("does not choke on a schema it cannot read", () => {
    const odd = [{ name: "x", description: "d", inputSchema: { type: "object" } }];
    expect(chooseModel({ MODEL_EASY: "easy", MODEL_HARD: "hard" }, odd, firstTurn)).toBe("easy");
  });
});
