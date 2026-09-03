import type { McpToolDescriptor } from "../../shared/mcp";
import type { ToolManifest } from "../../shared/manifest";
import { MANIFESTS } from "../manifests";
import { getRegistryEntry, blessedManifests, type KvLike } from "../manifest-registry";

/**
 * The three always-on tools. Same names the WebMCP façade registers, so an
 * agent that learned them from one surface sees the same names on the other.
 */
const SPINE: McpToolDescriptor[] = [
  {
    name: "get_page_state",
    description:
      "Text description of the remote browser view. Required: the model cannot see the canvas.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_available_origins",
    description: "Origins this session may act on, after consent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "navigate_to",
    description:
      "Navigate the remote browser to an https origin the user has granted.",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "https origin or URL" },
      },
      required: ["origin"],
      additionalProperties: false,
    },
  },
];

export const SPINE_NAMES = SPINE.map((t) => t.name);

/**
 * Build the tool list an MCP client sees. SPINE is always present. Per-origin
 * manifests are included only for granted origins — ungranted origins are
 * invisible, not "denied at call time."
 */
export async function buildToolList(
  consented: ReadonlySet<string>,
  kv?: KvLike,
): Promise<McpToolDescriptor[]> {
  const out: McpToolDescriptor[] = [...SPINE];
  for (const m of MANIFESTS) {
    if (!consented.has(m.origin)) continue;
    out.push({
      name: m.name,
      description: m.description,
      inputSchema: m.inputSchema as unknown as Record<string, unknown>,
    });
  }
  if (kv) {
    for (const origin of consented) {
      const entry = await getRegistryEntry(kv, origin);
      for (const m of blessedManifests(entry)) {
        out.push({
          name: m.name,
          description: m.description,
          inputSchema: m.inputSchema as unknown as Record<string, unknown>,
        });
      }
    }
  }
  return out;
}

/** Read the persisted consent list from the session DO. */
export function consentedOriginsFromRows(consent: string[]): Set<string> {
  return new Set(consent.filter((x) => typeof x === "string"));
}

/** Used by tests to assert which manifests are in scope. */
export function manifestByName(name: string): ToolManifest | undefined {
  return MANIFESTS.find((m) => m.name === name);
}