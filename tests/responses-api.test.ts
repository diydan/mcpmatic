import { describe, expect, it } from "vitest";
import { isResponsesModel, responsesBody, decideResponses } from "../worker/agent";

const tools = [
  {
    name: "search_catalog",
    description: "Search the store",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
];

describe("isResponsesModel", () => {
  it("recognises the gpt-5.6 family, which the docs list as Responses format", () => {
    expect(isResponsesModel("openai/gpt-5.6-luna")).toBe(true);
    expect(isResponsesModel("openai/gpt-5.6-sol")).toBe(true);
    expect(isResponsesModel("openai/gpt-5.6-terra")).toBe(true);
  });

  it("leaves chat-completions models alone", () => {
    expect(isResponsesModel("openai/gpt-5.5")).toBe(false);
    expect(isResponsesModel("gpt-5.5")).toBe(false);
  });
});

describe("responsesBody", () => {
  const messages = [
    { role: "system" as const, content: "you are a browser" },
    { role: "user" as const, content: "find wool runners" },
  ];

  it("puts the system prompt in instructions, not in input", () => {
    const body = responsesBody(messages, tools) as Record<string, unknown>;
    expect(body.instructions).toBe("you are a browser");
    expect(JSON.stringify(body.input)).not.toContain("you are a browser");
  });

  it("sends the conversation as input items", () => {
    const body = responsesBody(messages, tools) as { input: Array<Record<string, unknown>> };
    expect(body.input).toEqual([{ role: "user", content: "find wool runners" }]);
  });

  it("flattens tools, which Responses declares differently from chat", () => {
    const body = responsesBody(messages, tools) as { tools: Array<Record<string, unknown>> };
    expect(body.tools[0]).toEqual({
      type: "function",
      name: "search_catalog",
      description: "Search the store",
      parameters: tools[0].inputSchema,
    });
  });

  it("omits tools entirely when there are none, rather than sending []", () => {
    // Manifest generation is the only caller that passes an empty list, and
    // OpenAI-compatible endpoints have rejected `tools: []` with
    // `Invalid 'tools': empty array`. Every other test stubs env.AI.run and
    // never reads the body, so without this the failure would only appear
    // in production.
    const body = responsesBody(messages, []) as Record<string, unknown>;
    expect("tools" in body).toBe(false);
  });

  it("carries a tool result back as function_call_output", () => {
    const withResult = [
      ...messages,
      { role: "tool" as const, tool_call_id: "call_1", content: "found 5" },
    ];
    const body = responsesBody(withResult, tools) as { input: Array<Record<string, unknown>> };
    expect(body.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "found 5",
    });
  });
});

describe("decideResponses", () => {
  it("reads a plain answer out of the output array", () => {
    const raw = {
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      ],
    };
    expect(decideResponses(raw)).toEqual({ kind: "message", content: "hello" });
  });

  it("reads a tool call, with arguments parsed from their JSON string", () => {
    const raw = {
      output: [
        { type: "function_call", call_id: "call_9", name: "search_catalog", arguments: '{"q":"wool"}' },
      ],
    };
    expect(decideResponses(raw)).toEqual({
      kind: "tool",
      id: "call_9",
      name: "search_catalog",
      arguments: { q: "wool" },
    });
  });

  it("prefers the tool call when the model both spoke and called", () => {
    const raw = {
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "searching" }] },
        { type: "function_call", call_id: "c1", name: "search_catalog", arguments: "{}" },
      ],
    };
    expect(decideResponses(raw)).toMatchObject({ kind: "tool", name: "search_catalog" });
  });

  it("says so plainly when the output carries nothing usable", () => {
    expect(decideResponses({ output: [] })).toEqual({
      kind: "message",
      content: "The model returned no output.",
    });
  });

  it("does not throw on unparseable arguments", () => {
    const raw = {
      output: [{ type: "function_call", call_id: "c", name: "search_catalog", arguments: "{oops" }],
    };
    expect(decideResponses(raw)).toMatchObject({ kind: "tool", arguments: {} });
  });
});

describe("responsesBody — a tool call round trip", () => {
  // The turn that opens with a tool call is now the normal case: the system
  // prompt requires navigate_to first. Chaining it back for the follow-up
  // call sends the assistant's tool_calls plus the tool's result, and the
  // Responses API rejects a function_call_output whose call_id matches no
  // function_call in the same input — "7003: User Input Error" on screen,
  // with the page already navigated and the user left mid-task.
  const chained = [
    { role: "system" as const, content: "you operate websites" },
    { role: "user" as const, content: "plan and price my trip" },
    {
      role: "assistant" as const,
      content: "",
      tool_calls: [
        {
          id: "call_abc123",
          type: "function" as const,
          function: {
            name: "navigate_to",
            arguments: '{"origin":"https://www.kayak.com"}',
          },
        },
      ],
    },
    {
      role: "tool" as const,
      tool_call_id: "call_abc123",
      content: "opened https://www.kayak.com",
    },
  ];

  function input() {
    return (
      responsesBody(chained, []) as { input: Array<Record<string, unknown>> }
    ).input;
  }

  it("emits a function_call for the assistant's tool call", () => {
    const call = input().find((i) => i.type === "function_call");
    expect(call).toBeTruthy();
    expect(call).toMatchObject({
      call_id: "call_abc123",
      name: "navigate_to",
      arguments: '{"origin":"https://www.kayak.com"}',
    });
  });

  it("puts the function_call before the output that answers it", () => {
    const items = input();
    const call = items.findIndex((i) => i.type === "function_call");
    const output = items.findIndex((i) => i.type === "function_call_output");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(output).toBeGreaterThan(call);
  });

  it("does not send an empty assistant turn alongside the call", () => {
    // content was "" because the model spoke only by calling a tool.
    const empty = input().filter(
      (i) => i.role === "assistant" && i.content === "",
    );
    expect(empty).toHaveLength(0);
  });

  it("keeps an assistant turn that carried real text", () => {
    const spoken = responsesBody(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "on it" },
      ],
      [],
    ) as { input: Array<Record<string, unknown>> };
    expect(spoken.input).toContainEqual({ role: "assistant", content: "on it" });
  });
});
