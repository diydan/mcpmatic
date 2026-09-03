import { describe, expect, it } from "vitest";
import { manifestByName } from "../worker/mcp/tools";
import { originOfTool } from "../worker/manifests";

describe("MCP callTool contract helpers", () => {
  it("manifestByName finds a known manifest", () => {
    const m = manifestByName("search_flights_on_kayak_com");
    expect(m?.origin).toBe("https://www.kayak.com");
  });

  it("originOfTool returns the manifest origin", async () => {
    expect(await originOfTool("search_flights_on_kayak_com")).toBe("https://www.kayak.com");
  });

  it("originOfTool returns null for spine tools", async () => {
    expect(await originOfTool("get_page_state")).toBeNull();
    expect(await originOfTool("navigate_to")).toBeNull();
  });
});