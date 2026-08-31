export const PROTOCOL_V = 1 as const;

export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AuditRow = {
  origin: string;
  tool: string;
  fieldNames: string[];
  timestamp: number;
};

export type ClientMessage =
  | { v: 1; type: "chat"; content: string; tools: ToolSchema[] }
  | {
      v: 1;
      type: "input";
      kind: "mouse";
      action: "moved" | "pressed" | "released" | "wheel";
      x: number;
      y: number;
      button?: number;
      deltaX?: number;
      deltaY?: number;
    }
  | {
      v: 1;
      type: "input";
      kind: "key";
      action: "down" | "up" | "insert";
      key?: string;
      text?: string;
    }
  | {
      v: 1;
      type: "tool_exec";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { v: 1; type: "screencast"; on: boolean }
  | { v: 1; type: "ping" };

export type ServerMessage =
  | {
      v: 1;
      type: "frame";
      jpeg: string;
      width: number;
      height: number;
      sessionId: number;
    }
  | { v: 1; type: "assistant"; content: string }
  | {
      v: 1;
      type: "tool_call";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { v: 1; type: "tool_exec_result"; id: string; ok: boolean; result: string }
  | {
      v: 1;
      type: "state";
      origin: string | null;
      driving: boolean;
      browser: "live" | "missing";
    }
  | { v: 1; type: "audit"; rows: AuditRow[] }
  | { v: 1; type: "error"; message: string }
  | { v: 1; type: "pong" };

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const msg = value as { v?: unknown; type?: unknown };
  if (msg.v !== 1 || typeof msg.type !== "string") return null;
  return value as ClientMessage;
}

export const AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  tool TEXT NOT NULL,
  field_names TEXT NOT NULL,
  ts INTEGER NOT NULL
)
`.trim();
