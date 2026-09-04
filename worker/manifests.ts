import { ALWAYS_ON_TOOLS, type ToolManifest } from "../shared/manifest";
import { allManifests } from "../shared/stores";
import { getApprovedManifestByName, type KvLike } from "./manifest-registry";

export const MANIFESTS: ToolManifest[] = allManifests();

const byName = new Map(MANIFESTS.map((m) => [m.name, m]));
const ALWAYS_ON = new Set<string>(ALWAYS_ON_TOOLS);

/**
 * Static lookup always wins and never touches kv — a demo-store tool costs
 * no KV round-trip. An always-on (spine) tool short-circuits before either:
 * it is never in the static list and never in the registry, so without this
 * guard every spine call (including get_page_state, the most-invoked tool
 * in the system) would fall through to a guaranteed-miss KV read.
 */
export async function manifestFor(
  name: string,
  kv?: KvLike,
): Promise<ToolManifest | undefined> {
  if (ALWAYS_ON.has(name)) return undefined;
  const known = byName.get(name);
  if (known) return known;
  if (!kv) return undefined;
  return getApprovedManifestByName(kv, name);
}

export async function originOfTool(name: string, kv?: KvLike): Promise<string | null> {
  const manifest = await manifestFor(name, kv);
  return manifest?.origin ?? null;
}
