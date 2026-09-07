import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decide,
  initialMessages,
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
  // This used to assert `{ gateway: { id: "default" } }`. Forcing every call
  // through a gateway named "default" is not what the binding's documented
  // usage does, and it cost a live task: `openai/gpt-5.6-luna` was permitted
  // on that gateway and `openai/gpt-5.6-sol` was not, so the agent died on
  // its third call with "2018: Invalid User Credentials" — an error about
  // the gateway, on a worker whose account was fine. A gateway is a
  // deployment choice; absent AI_GATEWAY_ID there is none to choose.
  it("qualifies a bare model, sends the tools, and invents no gateway", async () => {
    const run = vi.fn(async () => GATEWAY_RESPONSE);
    const decision = await runTurn(
      { AI: { run }, OPENAI_MODEL: "gpt-5.5" },
      MESSAGES,
      TOOLS,
    );

    const [model, body, options] = run.mock.calls[0];
    expect(model).toBe("openai/gpt-5.5");
    expect(options).toBeUndefined();
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
      { AI: { run }, OPENAI_MODEL: "openai/gpt-5-mini", AI_GATEWAY_ID: "browsermatic" },
      MESSAGES,
      TOOLS,
    );
    expect(run.mock.calls[0][0]).toBe("openai/gpt-5-mini");
    expect(run.mock.calls[0][2]).toEqual({ gateway: { id: "browsermatic" } });
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

describe("SYSTEM prompt", () => {
  const system = String(initialMessages("plan a trip")[0].content);

  it("licenses navigation to any https site", () => {
    // Spec §2: with no origin granted the model sees only the spine and
    // previously had no licence to pick a destination.
    expect(system).toContain("You may navigate to any https site you judge relevant to the task.");
  });

  it("requires the first tool call to be a navigation", () => {
    // Spec §6: this is the primary mechanism for "a page always renders".
    expect(system).toContain("Your first tool call on a new task is always navigate_to, so the user sees a live page as early as possible.");
  });

  it("presents pre-wired origins as examples, not as the available world", () => {
    expect(system).toMatch(/not the list of sites you may visit/i);
  });

  it("still forbids inventing tools", () => {
    // Load-bearing for the approval story; must survive the rewrite.
    expect(system).toContain("Never invent tools");
  });

  it("still tells the model it cannot see the page", () => {
    expect(system).toContain("You cannot see the remote pixels.");
    expect(system).toContain("get_page_state");
  });

  it("does not tell the model to hide the approval gate", () => {
    // "Never tell the user you proposed a tool" was meant as "do not claim
    // credit for something that did not happen". As written it instructed
    // silence about the manifest-approval gate — the branch's whole safety
    // story — on the branch that lets the agent roam onto sites the user
    // never named.
    expect(system).not.toContain("Never tell the user you proposed a tool");
    expect(system).not.toMatch(/(never|don't|do not)\s+(tell|mention|say)[^.]*approv/i);
  });

  it("still forbids claiming credit for a tool it did not call", () => {
    expect(system).toContain(
      "Never claim you proposed or created a tool; report the tool you actually called and what it returned.",
    );
  });

  it("says the approval gate may be described to the user", () => {
    expect(system).toContain("A human approves each generated tool by name before any of them can run");
    expect(system).toMatch(/not something to hide/i);
  });

  it("names list_remote_tools as the trigger for tool synthesis, not inspect_site", () => {
    expect(system).toContain("Call list_remote_tools to find out whether the site publishes WebMCP tools of its own — on a site that publishes none, that call is what starts synthesising draft tools for it.");
    expect(system).not.toContain("Call inspect_site to see what it exposes, then propose a manifest");
  });
});

describe("a model that the account cannot call", () => {
  // Observed in production: the chain ran navigate_to and two list_remote_tools,
  // then the turn escalated past CHAINING_AFTER and died on the bare provider
  // string "2018: Invalid User Credentials". It named no model and no call
  // site, so which of two candidate paths produced it took three runs and a
  // wrong hypothesis to narrow down. And one unreachable model cost the user
  // the whole task, with a navigated page still on screen.
  const chained: ChatTurn[] = [
    { role: "user", content: "find me a flight" },
    { role: "tool", tool_call_id: "a", content: "opened kayak" },
    { role: "tool", tool_call_id: "b", content: "no webmcp tools" },
  ];

  it("escalates past two tool results, as designed", async () => {
    const run = vi.fn(async () => GATEWAY_RESPONSE);
    await runTurn({ AI: { run } }, chained, TOOLS);
    expect(run.mock.calls[0][0]).toBe("openai/gpt-5.6-sol");
  });

  it("falls back to the working model rather than losing the turn", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("2018: Invalid User Credentials"))
      .mockResolvedValueOnce(GATEWAY_RESPONSE);

    const decision = await runTurn({ AI: { run } }, chained, TOOLS);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toBe("openai/gpt-5.6-sol");
    expect(run.mock.calls[1][0]).toBe("openai/gpt-5.6-luna");
    expect(decision).toMatchObject({ name: "search_catalog_on_allbirds_com" });
  });

  it("names the model when the fallback fails too", async () => {
    const run = vi.fn(async () => {
      throw new Error("2018: Invalid User Credentials");
    });
    await expect(runTurn({ AI: { run } }, chained, TOOLS)).rejects.toThrow(
      /openai\/gpt-5\.6-luna/,
    );
  });

  it("keeps the provider's own words in the message", async () => {
    const run = vi.fn(async () => {
      throw new Error("2018: Invalid User Credentials");
    });
    await expect(runTurn({ AI: { run } }, chained, TOOLS)).rejects.toThrow(
      /Invalid User Credentials/,
    );
  });

  it("does not retry when the failing model was already the fallback", async () => {
    // A single-model turn has nowhere to degrade to; retrying the same model
    // just doubles the latency before the same failure.
    const run = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(runTurn({ AI: { run } }, MESSAGES, TOOLS)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
