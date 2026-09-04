import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FACADE_HEADERS } from "../worker/facade-headers";

/**
 * Regression coverage for audit §1.5 in task-1-report.md — the SPA's
 * static + dynamic response headers were missing the framing and
 * script-injection defenses every public-readiness deployment is
 * expected to ship.
 *
 * After the fix:
 *   - `X-Frame-Options: DENY` on every response the Worker emits and on
 *     every static asset Pages serves.
 *   - `Content-Security-Policy` on the same surfaces, with a tight
 *     default-src of 'self' and explicit allow-listing for the inline
 *     theme-bootstrap script + Google Fonts (the two non-self surfaces
 *     that `index.html` actually needs).
 *   - `frame-ancestors 'none'` mirrors the X-Frame-Options rule for
 *     browsers that honour CSP (CSP supersedes XFO there).
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HEADERS_FILE = `${REPO_ROOT}/public/_headers`;

function readHeadersFile(): string {
  return readFileSync(HEADERS_FILE, "utf8");
}

describe("worker/facade-headers.ts — CSP + frame defenses", () => {
  it("sets X-Frame-Options: DENY", () => {
    expect(FACADE_HEADERS["X-Frame-Options"]).toBe("DENY");
  });

  it("sets a Content-Security-Policy header", () => {
    const csp = FACADE_HEADERS["Content-Security-Policy"];
    expect(typeof csp).toBe("string");
    expect(csp).toBeTruthy();
    // The default-src MUST be 'self' — that is the brief's "tight" requirement.
    // Whitelist any further origins via explicit directives.
    expect(csp).toMatch(/default-src\s+'self'/);
  });

  it("CSP allow-lists the Google Fonts surfaces (fonts.googleapis.com + fonts.gstatic.com)", () => {
    const csp = FACADE_HEADERS["Content-Security-Policy"] ?? "";
    expect(csp).toMatch(/style-src[^;]*fonts\.googleapis\.com/);
    expect(csp).toMatch(/font-src[^;]*fonts\.gstatic\.com/);
  });

  it("CSP includes frame-ancestors 'none' (CSP-side frame defense)", () => {
    const csp = FACADE_HEADERS["Content-Security-Policy"] ?? "";
    expect(csp).toMatch(/frame-ancestors\s+'none'/);
  });

  it("CSP allows the inline theme-bootstrap script (no external refactor)", () => {
    // The bootstrap script in index.html (lines 8-20) reads localStorage
    // and sets a data-theme attribute — it is small, has no eval, and is
    // documented as CSP-compatible in the audit. We allow inline scripts
    // rather than restructure the bootstrap. If the team wants to drop
    // this allowance, the path is to move the script to an external file
    // and remove the directive here.
    const csp = FACADE_HEADERS["Content-Security-Policy"] ?? "";
    expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("preserves the existing security headers (regression guard)", () => {
    expect(FACADE_HEADERS["Origin-Agent-Cluster"]).toBe("?1");
    expect(FACADE_HEADERS["Permissions-Policy"]).toBe("tools=*");
    expect(FACADE_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(FACADE_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("public/_headers — CSP + frame defenses on static asset responses", () => {
  // Pages reads public/_headers and applies the rules to every asset it
  // serves. The Worker also serves assets through the same facade layer
  // (worker/facade-headers.ts), but Pages can serve from the CDN edge
  // directly for some routes — both surfaces must carry the same
  // posture, so the file is asserted explicitly.

  it("file exists and is non-empty", () => {
    const content = readHeadersFile();
    expect(content.length).toBeGreaterThan(0);
  });

  it("sets X-Frame-Options: DENY", () => {
    const content = readHeadersFile();
    // Pages header files allow indented header lines under a path matcher
    // — match either flat or indented so the test holds as the file grows.
    expect(content).toMatch(/^\s*X-Frame-Options:\s*DENY\s*$/m);
  });

  it("sets a Content-Security-Policy header with default-src 'self'", () => {
    const content = readHeadersFile();
    expect(content).toMatch(/^\s*Content-Security-Policy:\s*.+/m);
    const cspLine = content
      .split("\n")
      .find((line) => /^\s*Content-Security-Policy:/.test(line));
    expect(cspLine).toBeDefined();
    const csp = cspLine!.replace(/^\s*Content-Security-Policy:\s*/, "").trim();
    expect(csp).toMatch(/default-src\s+'self'/);
    expect(csp).toMatch(/frame-ancestors\s+'none'/);
    expect(csp).toMatch(/style-src[^;]*fonts\.googleapis\.com/);
    expect(csp).toMatch(/font-src[^;]*fonts\.gstatic\.com/);
    expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("preserves the existing static-asset headers (regression guard)", () => {
    const content = readHeadersFile();
    expect(content).toMatch(/^\s*Origin-Agent-Cluster:\s*\?1\s*$/m);
    expect(content).toMatch(/^\s*Permissions-Policy:\s*tools=\*\s*$/m);
    expect(content).toMatch(/^\s*Referrer-Policy:\s*no-referrer\s*$/m);
    expect(content).toMatch(/^\s*X-Content-Type-Options:\s*nosniff\s*$/m);
  });
});
