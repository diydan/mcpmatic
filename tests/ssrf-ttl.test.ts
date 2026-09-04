import { describe, expect, it, vi } from "vitest";
import { makeResolve4Records } from "../worker/doh-resolve4";
import { navigationStable } from "../worker/navigation-stable";

const okDoH = (
  records: Array<{ name: string; type: number; TTL: number; data: string }>,
) =>
  vi.fn(async (url: string) => {
    const u = new URL(url);
    const type = u.searchParams.get("type") === "AAAA" ? 28 : 1;
    return new Response(
      JSON.stringify({ Status: 0, Answer: records.filter((r) => r.type === type) }),
      { status: 200, headers: { "content-type": "application/dns-json" } },
    );
  });

describe("resolve4 TTL floor", () => {
  it("drops answers with TTL < 30s", async () => {
    const resolve = makeResolve4Records(
      okDoH([{ name: "x.example.", type: 1, TTL: 5, data: "1.2.3.4" }]),
    );
    const records = await resolve("x.example");
    expect(records.map((r) => r.ip)).not.toContain("1.2.3.4");
  });

  it("keeps answers with TTL >= 30s", async () => {
    const resolve = makeResolve4Records(
      okDoH([{ name: "x.example.", type: 1, TTL: 60, data: "1.2.3.4" }]),
    );
    const records = await resolve("x.example");
    expect(records.map((r) => r.ip)).toContain("1.2.3.4");
  });

  it("returns one of low/high records when at least one is high", async () => {
    const resolve = makeResolve4Records(
      okDoH([
        { name: "x.example.", type: 1, TTL: 5, data: "10.0.0.1" },
        { name: "x.example.", type: 1, TTL: 60, data: "1.2.3.4" },
      ]),
    );
    const records = await resolve("x.example");
    const ips = records.map((r) => r.ip);
    expect(ips).toContain("1.2.3.4");
    expect(ips).not.toContain("10.0.0.1");
  });
});

describe("navigationStable", () => {
  it("rejects on record flip", async () => {
    let flip = false;
    const resolveRecords = vi.fn(async () => {
      flip = !flip;
      return flip
        ? [{ ip: "1.2.3.4", ttl: 60 }]
        : [{ ip: "10.0.0.1", ttl: 60 }];
    });
    const result = await navigationStable("https://x.example/", resolveRecords);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/record flip/);
    }
  });

  it("accepts stable resolution", async () => {
    const resolveRecords = vi.fn(async () => [{ ip: "1.2.3.4", ttl: 60 }]);
    const result = await navigationStable("https://x.example/", resolveRecords);
    expect(result.ok).toBe(true);
  });

  it("rejects when first resolution is empty", async () => {
    const resolveRecords = vi.fn(async () => []);
    const result = await navigationStable("https://x.example/", resolveRecords);
    expect(result.ok).toBe(false);
  });
});