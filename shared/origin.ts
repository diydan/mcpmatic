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

/**
 * Union two origin lists, first list's order preserved, duplicates and blanks
 * dropped.
 *
 * Two callers need exactly this and for different reasons: autonomous mode
 * opens the demo catalog alongside whatever is already granted, and a session
 * claimed by an account inherits the account's grants on top of its own. One
 * function rather than two that drift.
 */
export function unionOrigins(
  first: readonly string[],
  second: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const origin of [...first, ...second]) {
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

/**
 * Resolve a typed site against a known catalog, so `allbirds.com` reaches the
 * storefront rather than a neighbouring origin with no tools.
 *
 * `https://allbirds.com` and `https://www.allbirds.com` are different origins,
 * and that distinction is deliberate — consent keys on it. But a person typing
 * the bare host means the store, and granting the bare host produced a session
 * that navigated to the storefront (which redirects to `www`) while consenting
 * to something else: no manifest matched, so no tools registered at all.
 *
 * Only an exact host match, ignoring a leading `www.`, is resolved. Anything
 * outside the catalog is returned exactly as it normalises, because guessing
 * `www` for arbitrary sites would grant an origin nobody asked for.
 */
export function canonicalOrigin(
  raw: string,
  catalog: readonly string[],
): string | null {
  const normalised = normaliseOrigin(raw);
  if (!normalised) return null;
  const bare = (host: string) => host.replace(/^www\./, "");
  let typed: string;
  try {
    typed = bare(new URL(normalised).hostname);
  } catch {
    return normalised;
  }
  for (const known of catalog) {
    try {
      if (bare(new URL(known).hostname) === typed) return known;
    } catch {
      /* a malformed catalog entry is not a match */
    }
  }
  return normalised;
}
