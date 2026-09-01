import { describe, expect, it } from "vitest";
import { extractBearer, isValidToken } from "../worker/mcp/auth";

describe("MCP bearer auth", () => {
  it("extracts a valid Bearer token", () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: "Bearer abc123" },
    });
    expect(extractBearer(req)).toBe("abc123");
  });

  it("returns null on missing Authorization header", () => {
    const req = new Request("https://example.com/mcp");
    expect(extractBearer(req)).toBeNull();
  });

  it("returns null on non-Bearer scheme", () => {
    const req = new Request("https://example.com/mcp", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(extractBearer(req)).toBeNull();
  });

  it("validates a 64-hex token", () => {
    const t = "a".repeat(64);
    expect(isValidToken(t)).toBe(true);
  });

  it("rejects malformed tokens", () => {
    expect(isValidToken("tooshort")).toBe(false);
    expect(isValidToken("z".repeat(64))).toBe(false); // non-hex
    expect(isValidToken("a".repeat(65))).toBe(false); // wrong length
  });
});
