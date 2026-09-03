/**
 * What a bridge socket is for.
 *
 * `console` is a human at `/c/<token>`: it holds the profile and is the only
 * thing that can answer an approval. `facade` is `/s/<token>`, which an agent
 * loads — it registers tools and must never be asked to release a field on the
 * human's behalf.
 *
 * Unlabelled means façade. This is not a boundary against the token holder
 * (see the spec's §Routing); it is what keeps an approval from being delivered
 * somewhere no human is reading, including to every client written before the
 * parameter existed.
 */
export type BridgeRole = "console" | "facade";

export function parseBridgeRole(url: string): BridgeRole {
  try {
    return new URL(url).searchParams.get("role") === "console"
      ? "console"
      : "facade";
  } catch {
    return "facade";
  }
}
