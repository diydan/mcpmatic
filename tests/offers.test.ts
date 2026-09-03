import { describe, expect, it } from "vitest";
import { offersFor } from "../src/lib/offers";

describe("offersFor", () => {
  it("suggests a profile approval when fill_checkout is registered", () => {
    const offers = offersFor({
      registered: [
        {
          name: "fill_checkout_on_allbirds_com",
          description: "Fill checkout",
        },
        { name: "search_catalog_on_allbirds_com", description: "Search" },
      ],
    });
    expect(offers.map((o) => o.name)).toEqual(["fill_checkout_on_allbirds_com"]);
    expect(offers[0].kind).toBe("profile");
  });

  it("suggests the council lookup as a blessed profile action", () => {
    const offers = offersFor({
      registered: [
        {
          name: "find_local_council_on_gov_uk",
          description: "Find council",
        },
      ],
    });
    expect(offers).toHaveLength(1);
    expect(offers[0].name).toBe("find_local_council_on_gov_uk");
  });

  it("does not offer ordinary catalog tools — ChatGPT calls those", () => {
    const offers = offersFor({
      registered: [
        { name: "search_catalog_on_allbirds_com", description: "Search" },
        { name: "get_page_state", description: "State" },
      ],
    });
    expect(offers).toEqual([]);
  });

  it("offers nothing until a page origin is known", () => {
    expect(
      offersFor({
        origin: null,
        registered: [
          {
            name: "find_local_council_on_gov_uk",
            description: "Find council",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("only offers profile actions for the open origin", () => {
    const offers = offersFor({
      origin: "https://www.kayak.com",
      registered: [
        {
          name: "fill_checkout_on_allbirds_com",
          description: "Fill checkout",
        },
        {
          name: "find_local_council_on_gov_uk",
          description: "Find council",
        },
      ],
    });
    expect(offers).toEqual([]);
  });
});
