/**
 * @vitest-environment node
 *
 * `public/_headers` carries the CSP for the app shell. It broke the recent-sites
 * favicons silently: 48ff3c7 added `img-src 'self' data:` while Home.tsx was
 * already loading icons from an external favicon service, so the images were
 * blocked with nothing on screen to say why. Nobody noticed until the custom
 * domain was repointed at a worker that actually served the header.
 *
 * This test ties the policy to the code that depends on it, so the next person
 * to tighten one without the other gets a failure instead of missing images.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const headers = readFileSync(path.join(root, "public/_headers"), "utf8");
const home = readFileSync(path.join(root, "src/pages/Home.tsx"), "utf8");

/** The `img-src` directive as a list of sources. */
function imgSrc(): string[] {
  const line = headers
    .split("\n")
    .find((l) => l.includes("Content-Security-Policy:"));
  expect(line, "public/_headers must set a Content-Security-Policy").toBeTruthy();
  const directive = (line as string)
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("img-src"));
  expect(directive, "the CSP must set img-src").toBeTruthy();
  return (directive as string).split(/\s+/).slice(1);
}

/** Every distinct external origin Home.tsx loads an image from. */
function externalImageHosts(): string[] {
  const hosts = new Set<string>();
  for (const m of home.matchAll(/src=\{?`?(https:\/\/[a-z0-9.-]+)/gi)) {
    hosts.add(m[1]);
  }
  return [...hosts];
}

describe("public/_headers CSP", () => {
  it("permits every external image origin Home.tsx actually loads", () => {
    const allowed = imgSrc();
    for (const host of externalImageHosts()) {
      expect(
        allowed.some((src) => src === host || src === "https:" || src === "*"),
        `img-src blocks ${host}, which src/pages/Home.tsx loads an image from`,
      ).toBe(true);
    }
  });

  it("still refuses to become a blanket allow-list", () => {
    // The fix for a blocked image is naming the origin, never `*`.
    expect(imgSrc()).not.toContain("*");
  });

  it("keeps the framing and default-src protections that shipped with it", () => {
    expect(headers).toContain("X-Frame-Options: DENY");
    expect(imgSrc()).toContain("'self'");
    expect(headers).toContain("default-src 'self'");
  });
});
