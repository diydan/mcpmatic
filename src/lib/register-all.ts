import type { ToolManifest } from "../../shared/manifest";
import { qualifiedToolName } from "../../shared/origin";
import type { DiscoveredTool } from "../../shared/protocol";
import { ensureModelContext } from "./webmcp-polyfill";

export type ApprovalRequest = {
  origin: string;
  tool: string;
  fieldNames: string[];
  destination: string;
};

export type RegisterOpts = {
  manifests: ToolManifest[];
  consented: ReadonlySet<string>;
  executeRemote: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  /**
   * Present only on the console at `/c/<token>`, which is where the profile
   * lives. The façade at `/s/<token>` is loaded by an agent and supplies
   * neither — a `fillsFrom` tool registered there still runs, and the DO
   * suspends it for the console to approve.
   */
  approve?: (req: ApprovalRequest) => Promise<boolean>;
  resolveFields?: (paths: readonly string[]) => Record<string, string>;
};

export type SyncReport = {
  registered: string[];
  removed: string[];
  failed: Array<{ name: string; message: string }>;
};

export type ObservedByOrigin = Readonly<Record<string, DiscoveredTool[]>>;

export type Registration = {
  /** Register what consent now allows; unregister what it no longer allows. */
  sync: (
    consented: ReadonlySet<string>,
    observed?: ObservedByOrigin,
  ) => Promise<SyncReport>;
  /** Abort every tool. The panel and ChatGPT both lose them (SPEC 1.3). */
  abort: () => void;
  names: () => string[];
};

type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** null for the always-on spine, which is not scoped to a target origin. */
  origin: string | null;
  fillsFrom?: string[];
  /** Observed remote tool: execute via call_remote_tool, not a manifest name. */
  remoteCall?: { nativeName: string };
};

const EMPTY_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/** Always on, independent of any origin-specific manifest (SPEC 3.2). */
const SPINE: ToolSpec[] = [
  {
    name: "get_page_state",
    description:
      "Text description of the remote browser view. Required: the model cannot see the canvas.",
    inputSchema: { ...EMPTY_INPUT },
    origin: null,
  },
  {
    name: "list_available_origins",
    description: "Origins this session may act on, after consent.",
    inputSchema: { ...EMPTY_INPUT },
    origin: null,
  },
  {
    name: "list_remote_tools",
    description:
      "List the WebMCP tools the site currently open in the remote browser exposes of its own, with schemas. Read-only; calls none of them.",
    inputSchema: { ...EMPTY_INPUT },
    origin: null,
  },
  {
    name: "call_remote_tool",
    description:
      "Call a WebMCP tool the open page registered of its own, by its native name. The origin must already be granted. Prefer the origin-qualified name ChatGPT sees on this page when one exists.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Native tool name on the open page, e.g. search_catalog",
        },
        arguments: {
          type: "object",
          description: "Arguments the remote tool's own schema accepts",
        },
        origin: {
          type: "string",
          description: "https origin of the page that registered the tool",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    origin: null,
  },
  {
    name: "get_page_errors",
    description:
      "Errors the open page itself reported this session: uncaught exceptions, console errors and warnings, failed requests, and 4xx/5xx responses. A replayed step that quietly did nothing usually left a trace here.",
    inputSchema: { ...EMPTY_INPUT },
    origin: null,
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
    origin: null,
  },
];

/**
 * The only path from a manifest to a tool. Keeps no private handler list —
 * consumers must go through getTools() / executeTool().
 *
 * One AbortController *per tool* (SPEC 2.5). A tool that is already registered
 * and still consented is never touched, so granting a second origin cannot
 * abort-and-re-register the first one's tools — the documented race.
 */
export function createRegistration(opts: RegisterOpts): Registration {
  const mc = ensureModelContext();
  const controllers = new Map<string, AbortController>();
  let consented: ReadonlySet<string> = opts.consented;
  let disposed = false;

  const wrap =
    (spec: ToolSpec) => async (input: Record<string, unknown>) => {
      const { origin, fillsFrom } = spec;
      // Consent is re-read at call time, not captured at registration.
      if (origin && !consented.has(origin)) {
        throw new Error(`origin not consented: ${origin}`);
      }
      let fills: Record<string, string> = {};
      // No profile reader here means this is the façade. Send the input as it
      // came; the fields are the console's to release, not this page's.
      if (fillsFrom?.length && opts.approve && opts.resolveFields) {
        const ok = await opts.approve({
          origin: origin ?? location.origin,
          tool: spec.name,
          fieldNames: fillsFrom,
          destination: origin ?? "remote page",
        });
        // Throw, don't return an error object: a rejected execute is a tool
        // error for ChatGPT too, and the in-page turn completes either way.
        if (!ok) throw new Error("user denied: profile fields not sent");
        fills = opts.resolveFields(fillsFrom);
      }
      if (spec.remoteCall) {
        return opts.executeRemote("call_remote_tool", {
          name: spec.remoteCall.nativeName,
          arguments: { ...input, ...fills },
          origin: spec.origin,
        });
      }
      return opts.executeRemote(spec.name, { ...input, ...fills });
    };

  let observed: ObservedByOrigin = {};

  const desired = (): Map<string, ToolSpec> => {
    const out = new Map<string, ToolSpec>();
    for (const spec of SPINE) out.set(spec.name, spec);
    for (const m of opts.manifests) {
      if (!consented.has(m.origin)) continue;
      out.set(m.name, {
        name: m.name,
        description: m.description,
        inputSchema: m.inputSchema as unknown as Record<string, unknown>,
        origin: m.origin,
        fillsFrom: m.fillsFrom,
      });
    }
    for (const [origin, tools] of Object.entries(observed)) {
      if (!consented.has(origin)) continue;
      for (const tool of tools) {
        const name = qualifiedToolName(tool.name, origin);
        if (out.has(name)) continue;
        out.set(name, {
          name,
          description: `${tool.description} (native ${tool.name} on ${origin.replace(/^https:\/\//, "")})`,
          inputSchema: tool.inputSchema,
          origin,
          remoteCall: { nativeName: tool.name },
        });
      }
    }
    return out;
  };

  let syncChain: Promise<SyncReport> = Promise.resolve({
    registered: [],
    removed: [],
    failed: [],
  });

  const syncOnce = async (
    next: ReadonlySet<string>,
    nextObserved: ObservedByOrigin | undefined,
  ): Promise<SyncReport> => {
      consented = next;
      if (nextObserved) observed = nextObserved;
      const report: SyncReport = { registered: [], removed: [], failed: [] };
      if (disposed) return report;
      const want = desired();

      for (const [name, ac] of [...controllers]) {
        if (want.has(name)) continue;
        ac.abort();
        controllers.delete(name);
        report.removed.push(name);
      }

      for (const [name, spec] of want) {
        // abort() may have landed while a previous registerTool was awaiting;
        // it clears the map, so without this we would re-register and re-abort.
        if (disposed) break;
        if (controllers.has(name)) continue;
        const ac = new AbortController();
        try {
          await mc.registerTool(
            {
              name: spec.name,
              description: spec.description,
              inputSchema: spec.inputSchema,
              execute: wrap(spec),
            },
            { signal: ac.signal },
          );
        } catch (err) {
          // One rejected schema must not abort the rest of the surface.
          ac.abort();
          report.failed.push({
            name,
            message: err instanceof Error ? err.message : "registerTool failed",
          });
          continue;
        }
        if (disposed) {
          // Aborted while this await was in flight (React StrictMode remount).
          ac.abort();
          continue;
        }
        controllers.set(name, ac);
        report.registered.push(name);
      }
      return report;
  };

  return {
    names: () => [...controllers.keys()],

    abort: () => {
      disposed = true;
      for (const ac of controllers.values()) ac.abort();
      controllers.clear();
    },

    sync: (next, nextObserved) => {
      const run = () => syncOnce(next, nextObserved);
      syncChain = syncChain.then(run, run);
      return syncChain;
    },
  };
}

/** Convenience wrapper: create and perform the first sync. */
export async function registerAll(opts: RegisterOpts): Promise<Registration> {
  const registration = createRegistration(opts);
  await registration.sync(opts.consented);
  return registration;
}
