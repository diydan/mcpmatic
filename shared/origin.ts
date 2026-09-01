/**
 * Normalise a human-typed site into an https origin, or reject it.
 *
 * The worker's consent route accepts any https origin, so this is a usability
 * shim, not a security boundary: "allbirds.com" and
 * "https://www.allbirds.com/products/x?y=1" both mean the same origin. The
 * SSRF guard still runs at navigation, which is the layer that matters.
 */
export function normaliseOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A bare host is the common case; assume https rather than rejecting it.
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
  return url.origin;
}
