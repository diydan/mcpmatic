import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBridge } from "../src/lib/bridge";

/**
 * The bridge is the only path a human's click takes to the session, and it is
 * the one piece of this app that had no test. Its socket does not survive the
 * session: the DO closes a same-role socket the moment another one connects
 * (`session-do.ts:506`), so a second console tab, or a reload racing the old
 * connection, leaves this page holding a dead socket.
 *
 * What that cost, measured against the deployed Worker: `exec` dropped the
 * frame (`readyState !== OPEN`), returned a promise nobody would ever settle,
 * and the human saw a button that did nothing for two minutes before the
 * 120s timeout finally spoke. These tests pin the contract that a call which
 * cannot be sent fails at once, and says why.
 */

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.OPEN;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(readonly url: string) {
    last = this;
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", { code: 1006, reason: "" });
  }

  /** A close that arrives from the server, as the DO's "replaced" does. */
  serverClose(code = 4000, reason = "replaced"): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  deliver(msg: unknown): void {
    this.emit("message", { data: JSON.stringify(msg) });
  }

  private emit(type: string, event: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

let last: FakeSocket | null = null;

/** Settles to the outcome, or reports that the promise is still pending. */
async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ status: "resolved"; value: T } | { status: "rejected"; message: string } | { status: "pending" }> {
  const pending = Symbol("pending");
  const race = await Promise.race([
    promise.then(
      (value) => ({ status: "resolved", value }) as const,
      (err: unknown) => ({
        status: "rejected",
        message: err instanceof Error ? err.message : String(err),
      }) as const,
    ),
    new Promise<typeof pending>((r) => setTimeout(() => r(pending), ms)),
  ]);
  return race === pending ? { status: "pending" } : race;
}

function open() {
  const bridge = openBridge("a".repeat(64), { onMessage: () => {} });
  return { bridge, socket: last! };
}

beforeEach(() => {
  last = null;
  Object.assign(globalThis, {
    WebSocket: FakeSocket,
    location: { protocol: "https:", host: "mcpmatic.test" },
  });
});

afterEach(() => {
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
  delete (globalThis as { location?: unknown }).location;
});

describe("bridge.exec", () => {
  it("resolves when the result for its id comes back", async () => {
    const { bridge, socket } = open();
    const call = bridge.exec("get_page_state", {});
    const { id } = JSON.parse(socket.sent[0]) as { id: string };
    socket.deliver({ v: 1, type: "tool_exec_result", id, ok: true, result: "URL: …" });
    await expect(call).resolves.toBe("URL: …");
  });

  it("rejects at once when the socket is not open", async () => {
    const { bridge, socket } = open();
    socket.readyState = FakeSocket.CLOSED;

    const outcome = await settleWithin(bridge.exec("fill_checkout", {}), 50);

    expect(outcome).toMatchObject({ status: "rejected" });
    expect(socket.sent).toEqual([]);
  });

  it("names the bridge, not a timeout, when it cannot send", async () => {
    const { bridge, socket } = open();
    socket.readyState = FakeSocket.CLOSED;
    await expect(bridge.exec("fill_checkout", {})).rejects.toThrow(/bridge/i);
  });

  it("rejects a call in flight when the server replaces the socket", async () => {
    const { bridge, socket } = open();
    const call = bridge.exec("fill_checkout", {});
    expect(socket.sent).toHaveLength(1);

    socket.serverClose(4000, "replaced");

    const outcome = await settleWithin(call, 50);
    expect(outcome).toMatchObject({ status: "rejected" });
  });

  it("settles a call in flight when the page closes the bridge itself", async () => {
    // One rule for every close: a socket that will never answer settles what
    // is waiting on it. Unmount suppresses the visible notice, not the reply.
    const { bridge, socket } = open();
    const call = bridge.exec("fill_checkout", {}).catch(() => "swallowed");
    bridge.close();
    socket.close();
    await expect(settleWithin(call, 50)).resolves.toMatchObject({
      status: "resolved",
    });
  });
});
