/**
 * Normalise a human-typed site into an https origin, or reject it.
 *
 * The worker's consent route accepts any https origin, so this is a usability
 * shim, not a security boundary: "allbirds.com" and
 * "https://www.allbirds.com/products/x?y=1" both mean the same origin. The
 * SSRF guard still runs at navigation, which is the layer that matters.
 */
/** Full https href the remote browser should open, or null if it is not a site. */
export function navigationHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!url.hostname.includes(".")) return null;
  return url.href;
}

export function normaliseOrigin(raw: string): string | null {
  const href = navigationHref(raw);
  if (!href) return null;
  return new URL(href).origin;
}

/** Hostname with `www.` stripped and dots turned into `_`. Used to origin-qualify tool names. */
export function originSlug(origin: string): string {
  let host = origin;
  try {
    host = new URL(origin).hostname;
  } catch {
    /* already a host */
  }
  return host
    .replace(/^www\./, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/**
 * ChatGPT's site tools are per-page; origin-qualified names keep two stores'
 * `search_catalog` from colliding on this façade.
 */
export function qualifiedToolName(nativeName: string, origin: string): string {
  const base = nativeName.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const name = `${base.slice(0, 80)}_on_${originSlug(origin)}`;
  return name.slice(0, 128);
}
