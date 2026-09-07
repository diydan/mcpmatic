/**
 * @vitest-environment node
 *
 * The worker broadcasts `tool_call` and then waits: `pending.waitingId` is set
 * and the agent turn cannot advance until the page answers with a matching
 * `tool_result`. Nothing in the client listened for `tool_call`, so every turn
 * that opened with a tool call hung forever — no reply, no error, `busy` stuck
 * on. `shared/protocol.ts` states the contract this restores: "The page sends
 * exactly one of these per `tool_call` it receives, on every exit path."
 *
 * "Every exit path" is the whole point, so these tests are mostly failures:
 * a tool that is missing, a tool that throws, a host that cannot even be
 * asked. Each one must still produce exactly one result carrying the model's
 * own call id.
 */
import { describe, expect, it, vi } from "vitest";
import { runToolCall, type ToolHost } from "../src/lib/tool-call-turn";

const req = {
  id: "call_abc123",
  name: "navigate_to",
  arguments: { origin: "https://www.kayak.com" },
};

function host(over: Partial<ToolHost> = {}): ToolHost {
  return {
    getTools: async () => [{ name: "navigate_to" }],
    executeTool: async () => "opened https://www.kayak.com",
    ...over,
  };
}

describe("runToolCall", () => {
  it("returns the tool's output against the model's call id", async () => {
    const result = await runToolCall(req, host());
    expect(result).toEqual({
      callId: "call_abc123",
      ok: true,
      result: "opened https://www.kayak.com",
    });
  });

  it("passes the model's arguments through to the named tool", async () => {
    const executeTool = vi.fn(async () => "ok");
    await runToolCall(req, host({ executeTool }));
    expect(executeTool).toHaveBeenCalledWith({ name: "navigate_to" }, {
      origin: "https://www.kayak.com",
    });
  });

  it("reports a tool the page never registered instead of hanging", async () => {
    const result = await runToolCall(req, host({ getTools: async () => [] }));
    expect(result.callId).toBe("call_abc123");
    expect(result.ok).toBe(false);
    expect(result.result).toContain("navigate_to");
    expect(result.result).toContain("not registered");
  });

  it("reports a tool that threw, carrying its message", async () => {
    const result = await runToolCall(
      req,
      host({
        executeTool: async () => {
          throw new Error("bridge is closed — reload to reconnect");
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.callId).toBe("call_abc123");
    expect(result.result).toBe("bridge is closed — reload to reconnect");
  });

  it("survives a tool that threw something that is not an Error", async () => {
    const result = await runToolCall(
      req,
      host({
        executeTool: async () => {
          throw "kaboom";
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.callId).toBe("call_abc123");
    expect(result.result.length).toBeGreaterThan(0);
  });

  it("answers even when the tool list itself cannot be read", async () => {
    // getTools reaches into the page's modelContext. If that throws, the turn
    // still has to be released — a silent return is the hang we are fixing.
    const result = await runToolCall(
      req,
      host({
        getTools: async () => {
          throw new Error("no modelContext on this page");
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.callId).toBe("call_abc123");
    expect(result.result).toBe("no modelContext on this page");
  });

  it("stringifies a non-string tool result", async () => {
    const result = await runToolCall(
      req,
      host({ executeTool: async () => ({ opened: true }) }),
    );
    expect(result.ok).toBe(true);
    expect(typeof result.result).toBe("string");
  });

  it("never rejects, whatever the host does", async () => {
    // The worker's turn is waiting on this call. A rejected promise here is
    // indistinguishable from the bug: the turn never resumes.
    await expect(
      runToolCall(
        req,
        host({
          getTools: () => Promise.reject(new Error("gone")),
        }),
      ),
    ).resolves.toBeTruthy();
  });
});
