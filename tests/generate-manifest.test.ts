import { describe, expect, it, vi } from "vitest";
import { generateManifest } from "../worker/generate-manifest";
import type { PageElement } from "../worker/dom-capture";

/** Verbatim shape returned by env.AI.run through AI Gateway — same fixture pattern as tests/agent.test.ts. */
/**
 * A Responses-API reply, which is what the default model (openai/gpt-5.6-luna)
 * routes to — `isResponsesModel` picks `decideResponses`, so a `choices`
 * fixture decodes to "The model returned no output." and every parse fails.
 */
function completionWith(content: string) {
  return {
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: content }] },
    ],
  };
}

const ELEMENTS: PageElement[] = [
  { role: "textbox", name: "Search", selector: "input#q" },
  { role: "button", name: "Go", selector: "button.go" },
];

const VALID_TOOL = {
  name: "search_widgets",
  description: "search the catalog",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  steps: [
    { action: "fill", selector: "input#q", from: "q" },
    { action: "click", selector: "button.go" },
  ],
};

describe("generateManifest", () => {
  it("parses and origin-qualifies a valid response", async () => {
    const run = vi.fn(async () => completionWith(JSON.stringify([VALID_TOOL])));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.manifests).toHaveLength(1);
    expect(outcome.manifests[0].name).toBe("search_widgets_on_example_com");
    expect(outcome.manifests[0].origin).toBe("https://example.com");
  });

  it("strips a markdown code fence around the JSON", async () => {
    const run = vi.fn(async () =>
      completionWith("```json\n" + JSON.stringify([VALID_TOOL]) + "\n```"),
    );
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(true);
  });

  it("rejects a response that isn't JSON", async () => {
    const run = vi.fn(async () => completionWith("sure, here are some tools: ..."));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.reason).toBe("invalid-response");
  });

  it("drops a tool whose step has an illegal action, keeps the rest", async () => {
    const bad = {
      ...VALID_TOOL,
      name: "bad_tool",
      steps: [{ action: "submit_payment", selector: "x" }],
    };
    const run = vi.fn(async () => completionWith(JSON.stringify([VALID_TOOL, bad])));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.manifests.map((m) => m.name)).toEqual(["search_widgets_on_example_com"]);
  });

  it("rejects outright when every tool is invalid", async () => {
    const run = vi.fn(async () => completionWith(JSON.stringify([{ name: 123 }])));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(false);
  });

  it("drops a tool with no steps", async () => {
    const run = vi.fn(async () => completionWith(JSON.stringify([{ ...VALID_TOOL, steps: [] }])));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(false);
  });

  it("reports a thrown error rather than crashing", async () => {
    const run = vi.fn(async () => {
      throw new Error("gateway unreachable");
    });
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.reason).toBe("threw");
  });
});

describe("generateManifest step/schema agreement", () => {
  it("drops a tool whose fill step draws from a key the schema does not declare", async () => {
    const mismatched = {
      ...VALID_TOOL,
      name: "mismatched",
      inputSchema: { type: "object", properties: { other: { type: "string" } } },
    };
    const run = vi.fn(async () => completionWith(JSON.stringify([mismatched])));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(false);
  });

  it("drops a fill tool whose schema declares no properties at all", async () => {
    const noProps = {
      ...VALID_TOOL,
      name: "no_props",
      inputSchema: { type: "object", properties: {} },
    };
    const run = vi.fn(async () => completionWith(JSON.stringify([noProps])));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(false);
  });

  it("keeps a tool with no fill/type steps regardless of its schema", async () => {
    const clickOnly = {
      name: "open_page",
      description: "open the page",
      inputSchema: { type: "object", properties: {} },
      steps: [{ action: "click", selector: "button.go" }],
    };
    const run = vi.fn(async () => completionWith(JSON.stringify([clickOnly])));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.manifests[0].name).toBe("open_page_on_example_com");
  });
});
