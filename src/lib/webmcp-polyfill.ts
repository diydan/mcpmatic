import type { ToolSchema } from "../../shared/protocol";

export type ExecuteFn = (
  input: Record<string, unknown>,
) => Promise<unknown> | unknown;

export type Registered = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  origin: string;
  execute: ExecuteFn;
};

declare global {
  interface Document {
    modelContext?: ModelContextLike;
  }
}

export type ModelContextLike = {
  registerTool: (
    tool: {
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
      execute: ExecuteFn;
    },
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
  getTools: () => Promise<
    Array<ToolSchema & { origin: string; window: Window }>
  >;
  executeTool: (
    tool: { name: string },
    input?: Record<string, unknown>,
  ) => Promise<string>;
  addEventListener: (
    type: "toolchange",
    listener: () => void,
  ) => void;
  removeEventListener: (
    type: "toolchange",
    listener: () => void,
  ) => void;
};

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

class PolyfillContext extends EventTarget {
  #tools = new Map<string, Registered>();

  async registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
      execute: ExecuteFn;
    },
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    if (!NAME_RE.test(tool.name) || !tool.description) {
      throw new DOMException("invalid tool", "InvalidStateError");
    }
    if (this.#tools.has(tool.name)) {
      throw new DOMException("duplicate tool", "InvalidStateError");
    }
    if (options?.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    this.#tools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      origin: location.origin,
      execute: tool.execute,
    });
    options?.signal?.addEventListener("abort", () => {
      this.#tools.delete(tool.name);
      this.dispatchEvent(new Event("toolchange"));
    });
    this.dispatchEvent(new Event("toolchange"));
  }

  async getTools(): Promise<
    Array<ToolSchema & { origin: string; window: Window }>
  > {
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      origin: t.origin,
      window,
    }));
  }

  async executeTool(
    tool: { name: string },
    input: Record<string, unknown> = {},
  ): Promise<string> {
    const rec = this.#tools.get(tool.name);
    if (!rec) {
      throw new DOMException("unknown tool", "NotFoundError");
    }
    const result = await rec.execute(input);
    return typeof result === "string" ? result : JSON.stringify(result);
  }
}

export function ensureModelContext(): ModelContextLike {
  if (typeof document.modelContext?.registerTool === "function") {
    return document.modelContext as ModelContextLike;
  }
  const poly = new PolyfillContext();
  Object.defineProperty(document, "modelContext", {
    value: poly,
    configurable: true,
  });
  return poly as unknown as ModelContextLike;
}
