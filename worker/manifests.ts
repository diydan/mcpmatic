import type { ToolManifest } from "../shared/manifest";
import { allManifests } from "../shared/stores";
import { getBlessedManifestByName, type KvLike } from "./manifest-registry";

export const MANIFESTS: ToolManifest[] = allManifests();

const byName = new Map(MANIFESTS.map((m) => [m.name, m]));

/** Static lookup always wins and never touches kv — a demo-store tool costs no KV round-trip. */
export async function manifestFor(
  name: string,
  kv?: KvLike,
): Promise<ToolManifest | undefined> {
  const known = byName.get(name);
  if (known) return known;
  if (!kv) return undefined;
  return getBlessedManifestByName(kv, name);
}

export async function originOfTool(name: string, kv?: KvLike): Promise<string | null> {
  if (name === "get_page_state" || name === "list_available_origins") return null;
  if (name === "list_remote_tools" || name === "call_remote_tool") return null;
  if (name === "navigate_to") return null;
  const manifest = await manifestFor(name, kv);
  return manifest?.origin ?? null;
}
