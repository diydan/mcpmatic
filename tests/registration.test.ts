/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureModelContext } from "../src/lib/webmcp-polyfill";
import { createRegistration } from "../src/lib/register-all";
import type { ToolManifest } from "../shared/manifest";

const ALLBIRDS = "https://www.allbirds.com";
const KAYAK = "https://www.kayak.com";

const manifests: ToolManifest[] = [
  {
    name: "search_catalog_on_allbirds_com",
    description: "Search Allbirds",
    origin: ALLBIRDS,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
    steps: [],
  },
  {
    name: "fill_checkout_on_allbirds_com",
    description: "Fill Allbirds checkout",
    origin: ALLBIRDS,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    fillsFrom: ["address.postcode"],
    steps: [],
  },
  {
    name: "search_flights_on_kayak_com",
    description: "Search flights",
    origin: KAYAK,
    inputSchema: {
      type: "object",
      properties: { origin: { type: "string" } },
      additionalProperties: false,
    },
    steps: [],
  },
];

function harness(over: Partial<Parameters<typeof createRegistration>[0]> = {}) {
  const executeRemote = vi.fn(async () => "ok");
  const bless = vi.fn(async () => true);
  const registration = createRegistration({
    manifests,
    consented: new Set(),
    executeRemote,
    bless,
    resolveFields: (paths) =>
      Object.fromEntries(paths.map((p) => [p, "EC2A 3DZ"])),
    ...over,
  });
  return { registration, executeRemote, bless };
}

afterEach(() => {
  Object.defineProperty(document, "modelContext", {
    value: undefined,
    configurable: true,
  });
});

describe("incremental registration", () => {
  it("registers the spine before any origin is consented", async () => {
    const { registration } = harness();
    const report = await registration.sync(new Set());
    expect(report.registered.sort()).toEqual([
      "call_remote_tool",
      "get_page_errors",
      "get_page_state",
      "list_available_origins",
      "list_remote_tools",
      "navigate_to",
    ]);
  });

  it("granting a second origin leaves the first origin's tools untouched", async () => {
    const mc = ensureModelContext();
    const { registration } = harness();
    await registration.sync(new Set([ALLBIRDS]));

    const spy = vi.spyOn(mc, "registerTool");
    const report = await registration.sync(new Set([ALLBIRDS, KAYAK]));

    // Only Kayak is registered on the second pass. Nothing is removed, and the
    // spine and Allbirds tools are never re-registered under the same name —
    // the abort-and-re-register race SPEC 2.5 forbids.
    expect(report.registered).toEqual(["search_flights_on_kayak_com"]);
    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);

    const names = (await mc.getTools()).map((t) => t.name);
    expect(names).toContain("search_catalog_on_allbirds_com");
    expect(names).toContain("search_flights_on_kayak_com");
    expect(names).toContain("get_page_state");
  });

  it("survives one tool whose registration is rejected", async () => {
    const mc = ensureModelContext();
    vi.spyOn(mc, "registerTool").mockImplementation(async (tool) => {
      if (tool.name === "navigate_to") throw new Error("schema rejected");
    });
    const { registration } = harness();
    const report = await registration.sync(new Set([KAYAK]));

    expect(report.failed).toEqual([
      { name: "navigate_to", message: "schema rejected" },
    ]);
    expect(report.registered).toContain("get_page_state");
    expect(report.registered).toContain("search_flights_on_kayak_com");
  });

  it("aborting empties the panel", async () => {
    const mc = ensureModelContext();
    const { registration } = harness();
    await registration.sync(new Set([KAYAK]));
    expect((await mc.getTools()).length).toBeGreaterThan(0);
    registration.abort();
    expect(await mc.getTools()).toEqual([]);
  });

  it("serialises overlapping syncs so a spine tool is not registered twice", async () => {
    const mc = ensureModelContext();
    const { registration } = harness();
    const first = registration.sync(new Set());
    const second = registration.sync(new Set([ALLBIRDS]));
    const [a, b] = await Promise.all([first, second]);
    expect([...a.failed, ...b.failed]).toEqual([]);
    const names = (await mc.getTools()).map((t) => t.name);
    expect(names.filter((n) => n === "get_page_state")).toHaveLength(1);
    expect(names).toContain("search_catalog_on_allbirds_com");
  });

  it("drops an origin's tools when consent is withdrawn", async () => {
    const { registration } = harness();
    await registration.sync(new Set([KAYAK]));
    const report = await registration.sync(new Set());
    expect(report.removed).toEqual(["search_flights_on_kayak_com"]);
    expect(registration.names()).not.toContain("search_flights_on_kayak_com");
  });
});

describe("execute refuses loudly", () => {
  it("throws when bless is denied, so the agent turn can complete", async () => {
    const mc = ensureModelContext();
    const { registration, executeRemote } = harness({ bless: async () => false });
    await registration.sync(new Set([ALLBIRDS]));

    const tool = (await mc.getTools()).find(
      (t) => t.name === "fill_checkout_on_allbirds_com",
    );
    await expect(mc.executeTool(tool!, {})).rejects.toThrow(/user denied/);
    expect(executeRemote).not.toHaveBeenCalled();
  });

  it("resolves fields only after bless, and only the declared path", async () => {
    const mc = ensureModelContext();
    const { registration, executeRemote } = harness();
    await registration.sync(new Set([ALLBIRDS]));

    const tool = (await mc.getTools()).find(
      (t) => t.name === "fill_checkout_on_allbirds_com",
    );
    await mc.executeTool(tool!, {});
    expect(executeRemote).toHaveBeenCalledWith("fill_checkout_on_allbirds_com", {
      "address.postcode": "EC2A 3DZ",
    });
  });

  it("sends no fields when no profile reader is supplied", async () => {
    // The façade at /s/<token> is loaded by an agent and holds no profile. A
    // fillsFrom tool still registers and still runs; the fields are supplied
    // later by the console, through the DO's approval. Prompting here would
    // put the dialog in an automated browser.
    const { registration, executeRemote, bless } = harness({
      bless: undefined,
      resolveFields: undefined,
    });
    const mc = ensureModelContext();
    await registration.sync(new Set([ALLBIRDS]));

    const tool = (await mc.getTools()).find(
      (t) => t.name === "fill_checkout_on_allbirds_com",
    );
    await mc.executeTool(tool!, {});
    expect(bless).not.toHaveBeenCalled();
    expect(executeRemote).toHaveBeenCalledWith("fill_checkout_on_allbirds_com", {});
  });

  it("registers observed remote tools origin-qualified without colliding with a manifest", async () => {
    const mc = ensureModelContext();
    const { registration, executeRemote } = harness();
    await registration.sync(new Set([ALLBIRDS]), {
      [ALLBIRDS]: [
        {
          name: "search_catalog",
          description: "Search the store catalog.",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
        {
          name: "get_product",
          description: "Get a product.",
          inputSchema: { type: "object", properties: { handle: { type: "string" } } },
        },
      ],
    });

    const names = (await mc.getTools()).map((t) => t.name);
    // Manifest already owns search_catalog_on_allbirds_com.
    expect(names.filter((n) => n === "search_catalog_on_allbirds_com")).toHaveLength(1);
    expect(names).toContain("get_product_on_allbirds_com");

    const tool = (await mc.getTools()).find((t) => t.name === "get_product_on_allbirds_com");
    await mc.executeTool(tool!, { handle: "wool-runner" });
    expect(executeRemote).toHaveBeenCalledWith("call_remote_tool", {
      name: "get_product",
      arguments: { handle: "wool-runner" },
      origin: ALLBIRDS,
    });
  });

  it("does not register observed tools for an origin that is not consented", async () => {
    const mc = ensureModelContext();
    const { registration } = harness();
    await registration.sync(new Set(), {
      [ALLBIRDS]: [
        {
          name: "get_product",
          description: "Get a product.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const names = (await mc.getTools()).map((t) => t.name);
    expect(names).not.toContain("get_product_on_allbirds_com");
  });

  it("re-reads consent at call time, not at registration time", async () => {
    const mc = ensureModelContext();
    const { registration, executeRemote } = harness();
    await registration.sync(new Set([ALLBIRDS, KAYAK]));
    const tool = (await mc.getTools()).find(
      (t) => t.name === "search_catalog_on_allbirds_com",
    );

    // Withdraw Kayak only. Allbirds stays granted and keeps working.
    await registration.sync(new Set([ALLBIRDS]));
    await mc.executeTool(tool!, { query: "runners" });
    expect(executeRemote).toHaveBeenCalledWith(
      "search_catalog_on_allbirds_com",
      { query: "runners" },
    );
  });
});
