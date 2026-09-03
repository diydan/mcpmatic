import type { ToolManifest } from "../shared/manifest";

export type GeneratedToolStatus = "draft" | "blessed" | "declined";

export type GeneratedTool = {
  manifest: ToolManifest;
  status: GeneratedToolStatus;
  generatedAt: number;
  blessedAt?: number;
};

export type RegistryEntry = {
  tools: GeneratedTool[];
};

/**
 * Minimal KV surface this module needs, mirroring how `is-private-url.ts`
 * takes a bare `Resolve4` function rather than `Env` — every caller here
 * tests against a plain object, never a real KVNamespace.
 */
export type KvLike = {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
};

function originKey(origin: string): string {
  return `origin:${origin}`;
}

function toolKey(name: string): string {
  return `tool:${name}`;
}

/** All tools ever generated for an origin, any status. Null if none. */
export async function getRegistryEntry(
  kv: KvLike,
  origin: string,
): Promise<RegistryEntry | null> {
  const raw = await kv.get(originKey(origin));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RegistryEntry;
    return Array.isArray(parsed.tools) ? parsed : null;
  } catch {
    return null;
  }
}

/** Just the blessed manifests from an entry, in the shape callers already use. */
export function blessedManifests(entry: RegistryEntry | null): ToolManifest[] {
  if (!entry) return [];
  return entry.tools.filter((t) => t.status === "blessed").map((t) => t.manifest);
}

/**
 * O(1) lookup by tool name, for `manifestFor`. Written alongside the
 * per-origin entry whenever a tool is blessed (Phase 2) — this phase only
 * reads it, and nothing writes it yet, so it always misses today.
 */
export async function getBlessedManifestByName(
  kv: KvLike,
  name: string,
): Promise<ToolManifest | undefined> {
  const raw = await kv.get(toolKey(name));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ToolManifest;
  } catch {
    return undefined;
  }
}

export { originKey as manifestRegistryOriginKey, toolKey as manifestRegistryToolKey };
