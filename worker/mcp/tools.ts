import type { McpToolDescriptor } from "../../shared/mcp";
import type { ToolManifest } from "../../shared/manifest";
import { MANIFESTS } from "../manifests";
import { getRegistryEntry, blessedManifests, type KvLike } from "../manifest-registry";

/**
 * The always-on tools. Same names the WebMCP façade registers, so an
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
  {
    name: "check_approval",
    description:
      "Collect the result of a tool call that returned approval-pending. Pass the id from that reply.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id from an approval-pending reply" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_page_errors",
    description:
      "Errors the open page itself reported this session: uncaught exceptions, console errors and warnings, failed requests, and 4xx/5xx responses. A replayed step that quietly did nothing usually left a trace here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const SPINE_NAMES = SPINE.map((t) => t.name);

/**
 * Build the tool list an MCP client sees. SPINE is always present. Per-origin
 * manifests are included only for granted origins — ungranted origins are
 * invisible, not "denied at call time."
 */
/**
 * A tool that draws on the local profile cannot run unattended: the profile
 * lives in the console's localStorage, never on the server. Say so in the
 * description so a planning client knows the cost before it calls, rather
 * than discovering it in an error.
 */
export const APPROVAL_NOTE = "Requires human approval in the BrowserMatic console.";

function toDescriptor(m: ToolManifest): McpToolDescriptor {
  return {
    name: m.name,
    description: m.fillsFrom?.length
      ? `${m.description} ${APPROVAL_NOTE}`
      : m.description,
    inputSchema: m.inputSchema as unknown as Record<string, unknown>,
  };
}

export async function buildToolList(
  consented: ReadonlySet<string>,
  kv?: KvLike,
): Promise<McpToolDescriptor[]> {
  const out: McpToolDescriptor[] = [...SPINE];
  const seen = new Set(out.map((t) => t.name));
  for (const m of MANIFESTS) {
    if (!consented.has(m.origin)) continue;
    out.push(toDescriptor(m));
    seen.add(m.name);
  }
  if (kv) {
    for (const origin of consented) {
      const entry = await getRegistryEntry(kv, origin);
      for (const m of blessedManifests(entry)) {
        // A registry entry that disagrees with its own key (mis-keyed data)
        // must never list a tool for an origin the caller didn't consent to.
        if (m.origin !== origin) continue;
        if (seen.has(m.name)) continue;
        out.push(toDescriptor(m));
        seen.add(m.name);
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