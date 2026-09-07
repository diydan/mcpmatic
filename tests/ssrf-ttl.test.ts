/**
 * The rebind defence, after the TTL floor was removed.
 *
 * The floor (Review H2) refused any DoH answer under 30 s, on the reasoning
 * that a short TTL is the rebind window. Its own comment allowed that this
 * "loses a few legitimate short-TTL hosts". It is not a few: the floor is
 * applied by `makeResolve4` as well as `makeResolve4Records`, so a short TTL
 * blocked session creation AND navigation, and short TTLs are how CDNs work.
 * Measured against production: johnlewis.com 20 s, news.ycombinator.com 1 s —
 * both rejected as "invalid origin", while the long-TTL catalog sites passed.
 * The demo worked; "any website" did not.
 *
 * What replaces it is the check the double-resolve should always have been
 * making. Set equality was a proxy for "the record did not change", but CDNs
 * change records constantly and a public-to-public rotation is not an attack.
 * The threat is a pivot *inward*, so the second resolution is now tested for
 * the property that matters: no private address, at either moment.
 *
 * The residual: an attacker who flips between two addresses they control,
 * both public, is no longer refused. They also gain nothing — the browser
 * reaches a public host either way, which it could have done directly.
 */
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

describe("resolve4 no longer judges an address by its TTL", () => {
  it("keeps a one-second answer — that is Hacker News", async () => {
    const resolve = makeResolve4Records(
      okDoH([{ name: "x.example.", type: 1, TTL: 1, data: "1.2.3.4" }]),
    );
    const records = await resolve("x.example");
    expect(records.map((r) => r.ip)).toContain("1.2.3.4");
  });

  it("keeps a twenty-second answer — that is Akamai", async () => {
    const resolve = makeResolve4Records(
      okDoH([{ name: "x.example.", type: 1, TTL: 20, data: "1.2.3.4" }]),
    );
    const records = await resolve("x.example");
    expect(records.map((r) => r.ip)).toContain("1.2.3.4");
  });

  it("keeps every record regardless of TTL, and reports the TTL it saw", async () => {
    const resolve = makeResolve4Records(
      okDoH([
        { name: "x.example.", type: 1, TTL: 5, data: "5.6.7.8" },
        { name: "x.example.", type: 1, TTL: 60, data: "1.2.3.4" },
      ]),
    );
    const records = await resolve("x.example");
    expect(records.map((r) => r.ip).sort()).toEqual(["1.2.3.4", "5.6.7.8"]);
    expect(records.find((r) => r.ip === "5.6.7.8")?.ttl).toBe(5);
  });

  it("still drops an answer of the wrong record type", async () => {
    const resolve = makeResolve4Records(
      okDoH([{ name: "x.example.", type: 5, TTL: 60, data: "cname.example." }]),
    );
    expect(await resolve("x.example")).toEqual([]);
  });
});

describe("navigationStable", () => {
  const publicIp = { ip: "1.2.3.4", ttl: 1 };
  const otherPublicIp = { ip: "5.6.7.8", ttl: 1 };
  const privateIp = { ip: "10.0.0.1", ttl: 1 };

  it("refuses a flip into private space — the rebind it exists to stop", async () => {
    let second = false;
    const resolve = vi.fn(async () => {
      const answer = second ? [privateIp] : [publicIp];
      second = true;
      return answer;
    });
    const result = await navigationStable("https://x.example/", resolve);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("10.0.0.1");
  });

  it("refuses when the first resolution is already private", async () => {
    const resolve = vi.fn(async () => [privateIp]);
    const result = await navigationStable("https://x.example/", resolve);
    expect(result.ok).toBe(false);
  });

  it("allows a public-to-public rotation — that is a CDN, not an attack", async () => {
    // The behaviour change. Set equality refused this, which is why removing
    // the TTL floor alone would have moved the rejection rather than fixed it.
    let second = false;
    const resolve = vi.fn(async () => {
      const answer = second ? [otherPublicIp] : [publicIp];
      second = true;
      return answer;
    });
    const result = await navigationStable("https://x.example/", resolve);
    expect(result.ok).toBe(true);
  });

  it("accepts a stable public resolution", async () => {
    const resolve = vi.fn(async () => [publicIp]);
    expect((await navigationStable("https://x.example/", resolve)).ok).toBe(true);
  });

  it("still resolves twice, so a later flip is seen at all", async () => {
    const resolve = vi.fn(async () => [publicIp]);
    await navigationStable("https://x.example/", resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("rejects when a resolution is empty", async () => {
    const resolve = vi.fn(async () => []);
    expect((await navigationStable("https://x.example/", resolve)).ok).toBe(false);
  });

  it("rejects an unparseable url", async () => {
    const resolve = vi.fn(async () => [publicIp]);
    expect((await navigationStable("not a url", resolve)).ok).toBe(false);
  });
});
