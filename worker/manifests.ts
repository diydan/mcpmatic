import type { ToolManifest } from "../shared/manifest";
import { allManifests } from "../shared/stores";

export const MANIFESTS: ToolManifest[] = allManifests();

export function manifestFor(name: string): ToolManifest | undefined {
  return MANIFESTS.find((m) => m.name === name);
}

export function originOfTool(name: string): string | null {
  if (name === "get_page_state" || name === "list_available_origins") return null;
  if (name === "list_remote_tools") return null;
  if (name === "navigate_to") return null;
  return manifestFor(name)?.origin ?? null;
}
