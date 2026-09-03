import { originSlug } from "../../shared/origin";

/**
 * Profile-gated actions the human should start, not ChatGPT.
 * Ordinary catalog tools stay in the chip list for ChatGPT to call.
 */
export type Offer = {
  name: string;
  label: string;
  kind: "profile";
};

export function offersFor(opts: {
  registered: Array<{ name: string; description: string }>;
  origin?: string | null;
}): Offer[] {
  if (opts.origin === null) return [];
  const suffix = opts.origin ? `_on_${originSlug(opts.origin)}` : null;
  const out: Offer[] = [];
  for (const tool of opts.registered) {
    if (suffix && !tool.name.endsWith(suffix)) continue;
    if (tool.name.startsWith("fill_checkout_")) {
      out.push({
        name: tool.name,
        label: "Fill shipping from your profile?",
        kind: "profile",
      });
      continue;
    }
    if (tool.name.startsWith("find_local_council_")) {
      out.push({
        name: tool.name,
        label: "Look up your council from your postcode?",
        kind: "profile",
      });
    }
  }
  return out;
}
