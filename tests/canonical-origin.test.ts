import { describe, expect, it } from "vitest";
import { canonicalOrigin } from "../shared/origin";

const CATALOG = [
  "https://www.allbirds.com",
  "https://www.brooklinen.com",
  "https://www.gov.uk",
];

describe("canonicalOrigin", () => {
  it("resolves a bare host to the catalog's origin", () => {
    // Typing "allbirds.com" granted https://allbirds.com, which is a different
    // origin from the storefront and keyed to none of its manifests — so the
    // session opened with no Allbirds tools at all.
    expect(canonicalOrigin("allbirds.com", CATALOG)).toBe("https://www.allbirds.com");
  });

  it("leaves an already-canonical origin alone", () => {
    expect(canonicalOrigin("https://www.allbirds.com", CATALOG)).toBe(
      "https://www.allbirds.com",
    );
  });

  it("ignores path and query", () => {
    expect(canonicalOrigin("https://www.allbirds.com/products/x?y=1", CATALOG)).toBe(
      "https://www.allbirds.com",
    );
  });

  it("resolves every catalog store, not just the first", () => {
    expect(canonicalOrigin("brooklinen.com", CATALOG)).toBe("https://www.brooklinen.com");
    expect(canonicalOrigin("gov.uk", CATALOG)).toBe("https://www.gov.uk");
  });

  it("leaves a site that is not in the catalog exactly as given", () => {
    expect(canonicalOrigin("example.com", CATALOG)).toBe("https://example.com");
  });

  it("does not match a host that merely contains a catalog host", () => {
    // notallbirds.com is not allbirds.com, and neither is allbirds.com.evil.tld.
    expect(canonicalOrigin("notallbirds.com", CATALOG)).toBe("https://notallbirds.com");
    expect(canonicalOrigin("allbirds.com.evil.tld", CATALOG)).toBe(
      "https://allbirds.com.evil.tld",
    );
  });

  it("returns null for something that is not a site", () => {
    expect(canonicalOrigin("not a url", CATALOG)).toBeNull();
    expect(canonicalOrigin("http://insecure.com", CATALOG)).toBeNull();
  });
});
