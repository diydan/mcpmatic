import type { ToolManifest } from "../../shared/manifest";
import { ensureModelContext } from "./webmcp-polyfill";

export type BlessRequest = {
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
  bless: (req: BlessRequest) => Promise<boolean>;
  resolveFields: (paths: readonly string[]) => Record<string, string>;
};

export type SyncReport = {
  registered: string[];
  removed: string[];
  failed: Array<{ name: string; message: string }>;
};

export type Registration = {
  /** Register what consent now allows; unregister what it no longer allows. */
  sync: (consented: ReadonlySet<string>) => Promise<SyncReport>;
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
      if (fillsFrom?.length) {
        const ok = await opts.bless({
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
      return opts.executeRemote(spec.name, { ...input, ...fills });
    };

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
    return out;
  };

  return {
    names: () => [...controllers.keys()],

    abort: () => {
      disposed = true;
      for (const ac of controllers.values()) ac.abort();
      controllers.clear();
    },

    sync: async (next) => {
      consented = next;
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
    },
  };
}

/** Convenience wrapper: create and perform the first sync. */
export async function registerAll(opts: RegisterOpts): Promise<Registration> {
  const registration = createRegistration(opts);
  await registration.sync(opts.consented);
  return registration;
}
