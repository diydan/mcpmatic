import { describe, expect, it } from "vitest";
import {
  navigationHref,
  normaliseOrigin,
  originSlug,
  qualifiedToolName,
} from "../shared/origin";

describe("normaliseOrigin", () => {
  it("accepts a bare host and assumes https", () => {
    expect(normaliseOrigin("allbirds.com")).toBe("https://allbirds.com");
    expect(normaliseOrigin("  www.allbirds.com  ")).toBe("https://www.allbirds.com");
  });

  it("strips path, query and hash down to the origin", () => {
    expect(normaliseOrigin("https://www.allbirds.com/products/x?y=1#z")).toBe(
      "https://www.allbirds.com",
    );
  });

  it("refuses anything that is not https", () => {
    expect(normaliseOrigin("http://allbirds.com")).toBeNull();
    expect(normaliseOrigin("file:///etc/passwd")).toBeNull();
    expect(normaliseOrigin("javascript:alert(1)")).toBeNull();
  });

  it("refuses empty and unqualified input", () => {
    expect(normaliseOrigin("")).toBeNull();
    expect(normaliseOrigin("   ")).toBeNull();
    // A hostname with no dot is a search term, not a site.
    expect(normaliseOrigin("localhost")).toBeNull();
    expect(normaliseOrigin("wool runners")).toBeNull();
  });

  it("passes private addresses through — the SSRF guard is the boundary", () => {
    // Consent is not the security layer; isPrivateUrl refuses at navigation.
    expect(normaliseOrigin("https://169.254.169.254")).toBe("https://169.254.169.254");
  });
});

describe("navigationHref", () => {
  it("keeps path and query so Enter can open a deep link", () => {
    expect(navigationHref("https://www.allbirds.com/products/x?y=1")).toBe(
      "https://www.allbirds.com/products/x?y=1",
    );
  });

  it("treats a bare host as https", () => {
    expect(navigationHref("allbirds.com")).toBe("https://allbirds.com/");
  });
});

describe("originSlug / qualifiedToolName", () => {
  it("strips www and turns dots into underscores", () => {
    expect(originSlug("https://www.allbirds.com")).toBe("allbirds_com");
    expect(originSlug("https://www.gov.uk")).toBe("gov_uk");
    expect(originSlug("https://brooklinen.com")).toBe("brooklinen_com");
  });

  it("origin-qualifies a native tool name for ChatGPT's per-page list", () => {
    expect(qualifiedToolName("search_catalog", "https://www.allbirds.com")).toBe(
      "search_catalog_on_allbirds_com",
    );
    expect(qualifiedToolName("get_product", "https://www.allbirds.com")).toBe(
      "get_product_on_allbirds_com",
    );
  });

  it("stays inside the WebMCP name charset and 128-char cap", () => {
    const name = qualifiedToolName("search catalog!", "https://www.allbirds.com");
    expect(name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    expect(name).not.toContain(" ");
    expect(name).not.toContain("!");
  });
});
