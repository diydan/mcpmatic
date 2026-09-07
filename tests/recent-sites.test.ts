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

  it("never returns the canned STORES fallback", () => {
    // This is the bug this function exists to prevent from recurring: a
    // first-time user must not get Allbirds (or any other canned entry)
    // back from the stored-only reader.
    const stored = getStoredRecentSites();
    expect(stored.some((s) => s.origin.includes("allbirds"))).toBe(false);
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
