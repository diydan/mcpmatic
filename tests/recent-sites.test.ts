/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  getRecentSites,
  getStoredRecentSites,
  recordRecentSite,
} from "../src/lib/recent-sites";

const KEY = "browsermatic.recentSites";

beforeEach(() => {
  localStorage.clear();
});

describe("getStoredRecentSites", () => {
  it("returns genuine stored history as-is", () => {
    // Seeded directly (rather than via recordRecentSite, which merges in
    // STORES on a first write) to isolate the reader's parsing from the
    // writer's merge behaviour.
    const entry = {
      origin: "https://www.kayak.com",
      label: "Kayak",
      kind: "facade",
      blurb: "Flights and hotels.",
      lastUsed: Date.now(),
    };
    localStorage.setItem(KEY, JSON.stringify([entry]));
    expect(getStoredRecentSites()).toEqual([entry]);
  });

  it("returns [] when nothing has ever been recorded", () => {
    // No key at all — a first-time visitor, the case the render fallback
    // must be able to distinguish from "has a real last site".
    expect(getStoredRecentSites()).toEqual([]);
  });

  it("returns [] for an empty stored array", () => {
    localStorage.setItem(KEY, "[]");
    expect(getStoredRecentSites()).toEqual([]);
  });

  it("returns [] for malformed JSON rather than throwing", () => {
    localStorage.setItem(KEY, "{not json");
    expect(getStoredRecentSites()).toEqual([]);
  });

  it("never returns the canned STORES fallback, even after a real visit", () => {
    // This is the bug this function exists to prevent from recurring, tested
    // where it actually happened rather than on an empty store.
    // `recordRecentSite` used to baseline off `getRecentSites()`, whose
    // first-visit fallback IS the canned list — so one genuine visit wrote
    // Allbirds, Brooklinen and Kayak into localStorage as if they were
    // history, and the render fallback then opened Allbirds on a
    // trip-planning task.
    recordRecentSite("https://www.example.test", "Example", "A real visit.");

    const stored = getStoredRecentSites();

    expect(stored.map((s) => s.origin)).toEqual(["https://www.example.test"]);
    expect(stored.some((s) => s.origin.includes("allbirds"))).toBe(false);
  });

  it("keeps a leftover canned row without re-seeding the rest of the catalog", () => {
    // A browser that visited before the fix still holds canned rows, and once
    // persisted they are indistinguishable from history — so they stay. What
    // must not happen is a new visit bringing the others back with them.
    const canned = {
      origin: "https://www.allbirds.com",
      label: "Allbirds",
      kind: "shopify-webmcp",
      blurb: "Wool runners.",
      lastUsed: Date.now() - 60_000,
    };
    const real = {
      origin: "https://www.gov.uk",
      label: "GOV.UK",
      kind: "facade",
      blurb: "Government services.",
      lastUsed: Date.now() - 30_000,
    };
    localStorage.setItem(KEY, JSON.stringify([real, canned]));

    recordRecentSite("https://www.example.test", "Example", "A real visit.");

    const origins = getStoredRecentSites().map((s) => s.origin);
    expect(origins).toEqual([
      "https://www.example.test",
      "https://www.gov.uk",
      "https://www.allbirds.com",
    ]);
    // Brooklinen and Kayak were never visited and must not appear.
    expect(origins.some((o) => o.includes("brooklinen"))).toBe(false);
    expect(origins.some((o) => o.includes("kayak"))).toBe(false);
  });

  it("the render fallback sees nothing at all until a real visit", () => {
    // `renderFallbackDecision` reads this list and navigates to entry zero.
    // An empty answer is what makes it decline rather than guess.
    expect(getStoredRecentSites()).toEqual([]);
    recordRecentSite("https://www.example.test", "Example", "A real visit.");
    expect(getStoredRecentSites()[0].origin).toBe("https://www.example.test");
  });
});

describe("getRecentSites (unchanged behaviour)", () => {
  it("still falls back to the canned STORES list for Home's suggestions", () => {
    // Home's "Last webpages automated" must keep showing something even for
    // a first-time visitor — only the Session render-fallback needed the
    // stricter stored-only reader.
    const sites = getRecentSites();
    expect(sites.length).toBeGreaterThan(0);
  });

  it("still returns real history first once something has been recorded", () => {
    recordRecentSite("https://www.gov.uk", "GOV.UK", "Government services.");
    const sites = getRecentSites();
    expect(sites[0].origin).toBe("https://www.gov.uk");
  });
});

describe("sites the agent opened on its own", () => {
  // "Last webpages automated" recorded only what the user typed. Once the
  // chips stopped carrying an origin, every site actually automated —
  // allbirds, rei, zappos, gov.uk, fandango, all chosen by the agent — was
  // reached through navigate_to, which never touches localStorage. The panel
  // was left listing the one thing it was not about.
  //
  // The new call site passes an origin and nothing else, so these pin what
  // recordRecentSite makes of a bare off-catalog origin.
  beforeEach(() => localStorage.clear());

  it("records an off-catalog origin under its hostname", () => {
    recordRecentSite("https://www.zappos.com");
    const [site] = getStoredRecentSites();
    expect(site.origin).toBe("https://www.zappos.com");
    expect(site.label).toBe("zappos.com");
    expect(site.blurb).toContain("zappos.com");
  });

  it("keeps the most recently opened site first", () => {
    recordRecentSite("https://www.rei.com");
    recordRecentSite("https://www.zappos.com");
    expect(getStoredRecentSites().map((s) => s.label)).toEqual([
      "zappos.com",
      "rei.com",
    ]);
  });

  it("does not list the same site twice when the agent returns to it", () => {
    recordRecentSite("https://www.rei.com");
    recordRecentSite("https://www.zappos.com");
    recordRecentSite("https://www.rei.com");
    const labels = getStoredRecentSites().map((s) => s.label);
    expect(labels).toEqual(["rei.com", "zappos.com"]);
  });

  it("still recognises a catalog site the agent chose by itself", () => {
    // Reached via navigate_to rather than a click, so no label is passed —
    // it must still come back as Allbirds, not "allbirds.com".
    recordRecentSite("https://www.allbirds.com");
    expect(getStoredRecentSites()[0].label).toBe("Allbirds");
  });
});
