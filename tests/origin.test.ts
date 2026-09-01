import { describe, expect, it } from "vitest";
import { normaliseOrigin } from "../shared/origin";

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
