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

/**
 * The only path from a manifest to a tool. Does not keep a private handler
 * list — consumers must call getTools() / executeTool().
 */
export async function registerAll(opts: RegisterOpts): Promise<AbortController> {
  const mc = ensureModelContext();
  const ac = new AbortController();
  const { signal } = ac;

  const wrap =
    (
      name: string,
      origin: string | null,
      fillsFrom: string[] | undefined,
    ) =>
    async (input: Record<string, unknown>) => {
      const fills = fillsFrom?.length
        ? opts.resolveFields(fillsFrom)
        : {};
      if (fillsFrom?.length) {
        const ok = await opts.bless({
          origin: origin ?? location.origin,
          tool: name,
          fieldNames: fillsFrom,
          destination: origin ?? "remote page",
        });
        if (!ok) {
          return { error: "user denied" };
        }
      }
      if (origin && !opts.consented.has(origin)) {
        return { error: "origin not consented" };
      }
      return opts.executeRemote(name, { ...input, ...fills });
    };

  await mc.registerTool(
    {
      name: "get_page_state",
      description:
        "Text description of the remote browser view. Required: the model cannot see the canvas.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: wrap("get_page_state", null, undefined),
    },
    { signal },
  );

  await mc.registerTool(
    {
      name: "list_available_origins",
      description: "Origins this session may act on, after consent.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: wrap("list_available_origins", null, undefined),
    },
    { signal },
  );

  await mc.registerTool(
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
      execute: wrap("navigate_to", null, undefined),
    },
    { signal },
  );

  for (const manifest of opts.manifests) {
    if (!opts.consented.has(manifest.origin)) continue;
    await mc.registerTool(
      {
        name: manifest.name,
        description: manifest.description,
        inputSchema: manifest.inputSchema,
        execute: wrap(manifest.name, manifest.origin, manifest.fillsFrom),
      },
      { signal },
    );
  }

  return ac;
}
