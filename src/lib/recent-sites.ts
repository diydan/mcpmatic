import { STORES, type StoreKind } from "../../shared/stores";

const RECENT_SITES_KEY = "browsermatic.recentSites";

export type RecentSite = {
  origin: string;
  label: string;
  kind: StoreKind;
  blurb: string;
  lastUsed: number;
};

function getDomainBase(hostname: string): string {
  const parts = hostname.replace(/^www\./, "").split(".");
  if (parts.length >= 2) {
    // e.g. "kayak.fr" -> "kayak", "allbirds.com" -> "allbirds"
    return parts[parts.length - 2];
  }
  return parts[0];
}

export function getRecentSites(): RecentSite[] {
  try {
    const raw = localStorage.getItem(RECENT_SITES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as RecentSite[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter(
          (s) =>
            s &&
            typeof s.origin === "string" &&
            s.origin.startsWith("http") &&
            s.label &&
            s.label !== "null" &&
            s.label !== "undefined",
        );
      }
    }
  } catch {
    /* ignore storage errors */
  }

  return STORES.map((s, idx) => ({
    origin: s.origin,
    label: s.label,
    kind: s.kind,
    blurb: s.blurb,
    lastUsed: Date.now() - idx * 60_000,
  }));
}

export function recordRecentSite(
  origin: string | null | undefined,
  label?: string,
  blurb?: string,
): void {
  if (!origin || typeof origin !== "string" || !origin.startsWith("http")) {
    return;
  }
  try {
    const norm = origin.replace(/\/+$/, "");
    let u: URL;
    try {
      u = new URL(norm);
    } catch {
      return;
    }

    const hostBase = getDomainBase(u.hostname);
    const existing = getRecentSites();

    // Match against STORES by origin OR domain root (e.g. kayak.fr matches kayak.com)
    const storeMatch = STORES.find((s) => {
      const sNorm = s.origin.replace(/\/+$/, "").toLowerCase();
      if (sNorm === norm.toLowerCase()) return true;
      try {
        const sUrl = new URL(s.origin);
        return getDomainBase(sUrl.hostname) === hostBase;
      } catch {
        return false;
      }
    });

    const siteOrigin = storeMatch ? storeMatch.origin : norm;
    const siteLabel = label || storeMatch?.label || u.hostname.replace(/^www\./, "");
    const siteKind: StoreKind = storeMatch?.kind ?? "facade";
    const siteBlurb =
      blurb ||
      storeMatch?.blurb ||
      `Automated browsing session on ${siteLabel}.`;

    const updated: RecentSite[] = [
      {
        origin: siteOrigin,
        label: siteLabel,
        kind: siteKind,
        blurb: siteBlurb,
        lastUsed: Date.now(),
      },
      ...existing.filter((s) => {
        if (s.origin.toLowerCase() === siteOrigin.toLowerCase()) return false;
        try {
          const itemUrl = new URL(s.origin);
          return getDomainBase(itemUrl.hostname) !== hostBase;
        } catch {
          return true;
        }
      }),
    ].slice(0, 8);

    localStorage.setItem(RECENT_SITES_KEY, JSON.stringify(updated));
  } catch {
    /* ignore storage errors */
  }
}
