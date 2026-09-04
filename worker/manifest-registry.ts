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

/**
 * `origin:<origin>` and `tool:<name>` are two views of the same data and
 * must be written and deleted together — `origin:<origin>` is authoritative
 * (it is what a per-origin listing reads); `tool:<name>` exists purely so
 * `manifestFor` can resolve a name in O(1) without knowing which origin to
 * list. KV has no cross-key transactions, so a write that updates one key
 * and not the other produces either a tool that's listed but not callable,
 * or callable but not listed. Whoever adds the write path (bless/decline)
 * owns keeping both in sync.
 */
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
 * True if the parsed value has every field manifestFor's caller relies on —
 * the origin drives the consent gate and SSRF check, steps drive browser
 * actions, so a malformed entry must miss cleanly, not produce a partial
 * ToolManifest with an undefined origin.
 */
function isToolManifest(value: unknown): value is ToolManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.name === "string" &&
    typeof m.description === "string" &&
    typeof m.origin === "string" &&
    Array.isArray(m.steps) &&
    !!m.inputSchema &&
    typeof m.inputSchema === "object"
  );
}

/**
 * O(1) lookup by tool name, for `manifestFor`. Written alongside the
 * per-origin entry whenever a tool is blessed — this code path only reads
 * it today, and nothing writes it yet, so it always misses.
 */
export async function getBlessedManifestByName(
  kv: KvLike,
  name: string,
): Promise<ToolManifest | undefined> {
  const raw = await kv.get(toolKey(name));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isToolManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export { originKey as manifestRegistryOriginKey, toolKey as manifestRegistryToolKey };
