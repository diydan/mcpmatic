import type { ClientMessage, ServerMessage } from "../../shared/protocol";

export type BridgeHandlers = {
  onMessage: (msg: ServerMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export function openBridge(
  sessionToken: string,
  handlers: BridgeHandlers,
): {
  send: (msg: ClientMessage) => void;
  close: () => void;
  exec: (name: string, args: Record<string, unknown>) => Promise<string>;
} {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/s/${sessionToken}/bridge`);
  const pending = new Map<
    string,
    { resolve: (s: string) => void; reject: (e: Error) => void }
  >();

  let closedByUs = false;
  ws.addEventListener("open", () => handlers.onOpen?.());
  // Only an unexpected close is worth reporting; unmount closes on purpose.
  ws.addEventListener("close", () => {
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

  const send = (msg: ClientMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
        pending.set(id, { resolve, reject });
        send({ v: 1, type: "tool_exec", id, name, arguments: args });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error("tool timed out"));
        }, 120_000);
      }),
  };
}
