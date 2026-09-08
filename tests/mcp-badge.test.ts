/**
 * @vitest-environment node
 *
 * "Actions on this page" showed the site's own WebMCP tools when it had them
 * and a line of prose when it did not, so telling the two apart meant reading
 * the panel. The distinction is the product's whole point — a site that ships
 * WebMCP is being asked, a site that does not is being driven — and it
 * deserves to be legible at a glance.
 *
 * Pure so the wording and the three states are pinned without rendering React,
 * the same reason grant-line.ts and render-fallback.ts are shaped this way.
 */
import { describe, expect, it } from "vitest";
import { mcpBadge } from "../src/lib/mcp-badge";

describe("mcpBadge", () => {
  it("says nothing when no page is open", () => {
    // Nothing has been inspected, so any claim would be invented.
    expect(mcpBadge({ origin: null, remoteToolCount: 0 })).toBeNull();
    expect(mcpBadge({ origin: null, remoteToolCount: 3 })).toBeNull();
  });

  it("marks a page that publishes its own tools as native", () => {
    const badge = mcpBadge({
      origin: "https://www.allbirds.com",
      remoteToolCount: 4,
    });
    expect(badge).toBeTruthy();
    expect(badge?.native).toBe(true);
    expect(badge?.label).toMatch(/webmcp/i);
  });

  it("marks a page with none as not publishing any", () => {
    const badge = mcpBadge({
      origin: "https://www.kayak.com",
      remoteToolCount: 0,
    });
    expect(badge).toBeTruthy();
    expect(badge?.native).toBe(false);
    expect(badge?.label).toMatch(/no webmcp/i);
  });

  it("distinguishes the two states by more than a boolean", () => {
    // The label is what a person reads; the two must not collide.
    const yes = mcpBadge({ origin: "https://a.example", remoteToolCount: 1 });
    const no = mcpBadge({ origin: "https://a.example", remoteToolCount: 0 });
    expect(yes?.label).not.toBe(no?.label);
  });

  it("counts a single tool as native", () => {
    // One registered tool is still the site speaking for itself.
    expect(mcpBadge({ origin: "https://a.example", remoteToolCount: 1 })?.native).toBe(
      true,
    );
  });
});
