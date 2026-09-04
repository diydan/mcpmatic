import { describe, expect, it } from "vitest";
import { FACADE_HEADERS } from "../worker/facade-headers";

describe("FACADE_HEADERS", () => {
  it("keeps the existing privacy headers", () => {
    expect(FACADE_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(FACADE_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(FACADE_HEADERS["Origin-Agent-Cluster"]).toBe("?1");
  });

  it("declares a CSP that forbids remote script and inline event handlers", () => {
    const csp = FACADE_HEADERS["Content-Security-Policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src");
  });

  it("sets HSTS for a year", () => {
    expect(FACADE_HEADERS["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("sets X-Frame-Options as a defence-in-depth against frame-ancestors bugs", () => {
    expect(FACADE_HEADERS["X-Frame-Options"]).toBe("DENY");
  });

  it("leaves Permissions-Policy unrestricted for `tools` (WebMCP)", () => {
    expect(FACADE_HEADERS["Permissions-Policy"]).toContain("tools=*");
  });
});