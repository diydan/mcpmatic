import { describe, expect, it } from "vitest";
import { buildToolList } from "../worker/mcp/tools";

describe("SessionDO.listTools contract (mocked via buildToolList)", () => {
  // The DO method is a thin wrapper around buildToolList(consented). We test
  // the wrapper logic by reproducing it here; integration is covered by the
  // e2e test in Task 9 against @modelcontextprotocol/sdk.
  it("returns SPINE only when no origins consented", async () => {
    const list = await buildToolList(new Set());
    expect(list.map((t) => t.name).sort()).toEqual([
      "check_approval",
      "get_page_state",
      "list_available_origins",
      "navigate_to",
    ]);
  });

  it("returns SPINE plus consented-origin tools", async () => {
    const list = await buildToolList(new Set(["https://www.kayak.com"]));
    const names = list.map((t) => t.name);
    expect(names).toContain("search_flights_on_kayak_com");
  });
});
