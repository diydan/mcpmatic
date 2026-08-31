import { describe, expect, it } from "vitest";
import { allManifests, STORES } from "../shared/stores";
import { isWebMcpToolName } from "../shared/manifest";
import { remoteNativeName } from "../worker/native-webmcp";

describe("demo stores", () => {
  it("includes two Shopify origins and one façade origin", () => {
    const kinds = STORES.map((s) => s.kind).sort();
    expect(kinds).toEqual(["facade", "shopify-webmcp", "shopify-webmcp"]);
  });

  it("origin-qualifies Shopify tools and maps them to native names", () => {
    const tools = allManifests().filter((m) => m.origin === "https://www.allbirds.com");
    const search = tools.find((t) => t.nativeName === "search_catalog");
    expect(search?.name).toBe("search_catalog_on_allbirds_com");
    expect(isWebMcpToolName(search!.name)).toBe(true);
    expect(remoteNativeName(search!.name, search!.nativeName)).toBe("search_catalog");
  });

  it("adds a checkout fill tool Shopify does not ship", () => {
    const fill = allManifests().find((t) => t.name === "fill_checkout_on_allbirds_com");
    expect(fill?.nativeName).toBeUndefined();
    expect(fill?.fillsFrom).toContain("address.postcode");
    expect(fill?.fillsFrom).not.toContain("shopper.size");
  });
});
