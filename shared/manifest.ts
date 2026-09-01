export type ManifestStep =
  | { action: "goto"; url: string }
  | { action: "fill"; selector: string; from: string }
  | { action: "type"; selector: string; from: string }
  | { action: "click"; selector: string }
  | { action: "press"; selector: string; key: string }
  | { action: "wait"; selector: string };

export type ToolKind = "shopify-webmcp" | "facade";

export type ToolManifest = {
  name: string;
  description: string;
  origin: string;
  /** When set, try this tool on the remote page's own document.modelContext first. */
  nativeName?: string;
  kind?: ToolKind;
  /**
   * For a proxied tool this mirrors the remote tool's own schema, so the model
   * produces arguments that pass straight through untranslated. JSON Schema is
   * nested, so the value type is deliberately open.
   */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: false;
  };
  fillsFrom?: string[];
  steps: ManifestStep[];
};

export const ALWAYS_ON_TOOLS = [
  "get_page_state",
  "list_available_origins",
  "navigate_to",
] as const;

export function isWebMcpToolName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(name);
}
