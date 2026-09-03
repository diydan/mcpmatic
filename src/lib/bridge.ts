import type { ClientMessage, ServerMessage } from "../../shared/protocol";

export type BridgeHandlers = {
  onMessage: (msg: ServerMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export function openBridge(
  sessionToken: string,
  handlers: BridgeHandlers,
  /**
   * Declared at connect so the DO can tag the socket. Only a `console` socket
   * is ever sent an approval — see worker/bridge-role.ts.
   */
  role: "console" | "facade" = "facade",
): {
  send: (msg: ClientMessage) => void;
  close: () => void;
  exec: (name: string, args: Record<string, unknown>) => Promise<string>;
} {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${proto}//${location.host}/s/${sessionToken}/bridge?role=${role}`,
  );
  const pending = new Map<
    string,
    { resolve: (s: string) => void; reject: (e: Error) => void }
  >();

  let closedByUs = false;
  ws.addEventListener("open", () => handlers.onOpen?.());
  // Only an unexpected close is worth reporting; unmount closes on purpose.
  // Whoever is waiting hears either way: the DO replaces a same-role socket
  // the moment another console connects, and a promise left pending there is
  // a button that does nothing for two minutes.
  ws.addEventListener("close", () => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(new Error("bridge closed before the tool answered"));
    }
    if (!closedByUs) handlers.onClose?.();
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "tool_exec_result") {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        if (msg.ok) waiter.resolve(msg.result);
        else waiter.reject(new Error(msg.result));
      }
    }
    handlers.onMessage(msg);
  });

  /** False when the socket could not take it. Fire-and-forget callers ignore
   * that; `exec`, which owes someone an answer, does not. */
  const send = (msg: ClientMessage): boolean => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  return {
    send,
    close: () => {
      closedByUs = true;
      ws.close();
    },
    exec: (name, args) =>
      new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        // Say so now. A dropped frame is indistinguishable from a slow tool
        // until the timeout fires, and by then the human has walked away.
        if (!send({ v: 1, type: "tool_exec", id, name, arguments: args })) {
          reject(new Error("bridge is closed — reload to reconnect"));
          return;
        }
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error("tool timed out"));
        }, 120_000);
      }),
  };
}
