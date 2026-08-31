import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decide,
  modelPath,
  runTurn,
  type ChatTurn,
} from "../worker/agent";
import type { ToolSchema } from "../shared/protocol";

const TOOLS: ToolSchema[] = [
  {
    name: "search_catalog_on_allbirds_com",
    description: "Search Allbirds",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  },
];

const MESSAGES: ChatTurn[] = [{ role: "user", content: "wool runners" }];

/** Verbatim shape returned by env.AI.run("openai/gpt-5.5", …) through AI Gateway. */
const GATEWAY_RESPONSE = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-5.5",
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: "call_qVFB7wtKH4OA9ipCWPyD313K",
            type: "function",
            function: {
              name: "search_catalog_on_allbirds_com",
              arguments: '{"query":"wool runners"}',
            },
          },
        ],
      },
    },
  ],
  usage: {},
  gatewayMetadata: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("modelPath", () => {
  it("prefers the AI binding over a key", () => {
    expect(modelPath({ AI: { run: vi.fn() }, OPENAI_API_KEY: "sk-x" })).toBe(
      "binding",
    );
  });

  it("falls back to a direct key", () => {
    expect(modelPath({ OPENAI_API_KEY: "sk-x" })).toBe("openai");
  });

  it("reports none when neither is configured", () => {
    expect(modelPath({})).toBe("none");
  });
});

describe("decide", () => {
  it("reads a tool call out of the gateway response", () => {
    expect(decide(GATEWAY_RESPONSE)).toEqual({
      kind: "tool",
      id: "call_qVFB7wtKH4OA9ipCWPyD313K",
      name: "search_catalog_on_allbirds_com",
      arguments: { query: "wool runners" },
    });
  });

  it("treats unparseable arguments as empty rather than throwing", () => {
    const broken = structuredClone(GATEWAY_RESPONSE);
    broken.choices[0].message.tool_calls[0].function.arguments = "{not json";
    expect(decide(broken)).toMatchObject({ kind: "tool", arguments: {} });
  });

  it("returns a plain message when no tool is called", () => {
    expect(
      decide({ choices: [{ message: { content: "  hello  " } }] }),
    ).toEqual({ kind: "message", content: "hello" });
  });
});

describe("runTurn via the AI binding", () => {
  it("qualifies a bare model, sends the tools, and uses the default gateway", async () => {
    const run = vi.fn(async () => GATEWAY_RESPONSE);
    const decision = await runTurn(
      { AI: { run }, OPENAI_MODEL: "gpt-5.5" },
      MESSAGES,
      TOOLS,
    );

    const [model, body, options] = run.mock.calls[0];
    expect(model).toBe("openai/gpt-5.5");
    expect(options).toEqual({ gateway: { id: "default" } });
    // The binding takes the model as its first argument, not in the body.
    expect(body).not.toHaveProperty("model");
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_catalog_on_allbirds_com",
          description: "Search Allbirds",
          parameters: TOOLS[0].inputSchema,
        },
      },
    ]);
    expect(decision).toMatchObject({ name: "search_catalog_on_allbirds_com" });
  });

  it("leaves an already-qualified model alone and honours a named gateway", async () => {
    const run = vi.fn(async () => GATEWAY_RESPONSE);
    await runTurn(
      { AI: { run }, OPENAI_MODEL: "openai/gpt-5-mini", AI_GATEWAY_ID: "mcpmatic" },
      MESSAGES,
      TOOLS,
    );
    expect(run.mock.calls[0][0]).toBe("openai/gpt-5-mini");
    expect(run.mock.calls[0][2]).toEqual({ gateway: { id: "mcpmatic" } });
  });

  it("never sends an API key when the binding is used", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const run = vi.fn(async () => GATEWAY_RESPONSE);
    await runTurn({ AI: { run }, OPENAI_API_KEY: "sk-should-not-be-used" }, MESSAGES, TOOLS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("runTurn via a direct key", () => {
  it("strips the provider prefix and authenticates", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => GATEWAY_RESPONSE,
    }));
    vi.stubGlobal("fetch", fetchSpy);

    await runTurn(
      { OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "openai/gpt-5.5" },
      MESSAGES,
      TOOLS,
    );

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-test",
    );
    expect(JSON.parse(init.body as string).model).toBe("gpt-5.5");
  });

  it("surfaces a provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, text: async () => "bad key" })),
    );
    await expect(
      runTurn({ OPENAI_API_KEY: "sk-bad" }, MESSAGES, TOOLS),
    ).rejects.toThrow(/OpenAI 401/);
  });

  it("refuses when nothing is configured", async () => {
    await expect(runTurn({}, MESSAGES, TOOLS)).rejects.toThrow(/ai. binding/);
  });
});
