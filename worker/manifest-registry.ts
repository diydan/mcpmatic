import type { ToolManifest } from "../shared/manifest";

export type GeneratedToolStatus = "draft" | "approved" | "declined";

export type GeneratedTool = {
  manifest: ToolManifest;
  status: GeneratedToolStatus;
  generatedAt: number;
  approvedAt?: number;
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
  /**
   * Required, not optional. `declineTool` is the revoke path and must be able
   * to remove the `tool:<name>` lookup key; a KV that cannot delete would
   * revoke in the listing and not in fact.
   */
  delete: (key: string) => Promise<void>;
};

/**
 * `origin:<origin>` and `tool:<name>` are two views of the same data and
 * must be written and deleted together — `origin:<origin>` is authoritative
 * (it is what a per-origin listing reads); `tool:<name>` exists purely so
 * `manifestFor` can resolve a name in O(1) without knowing which origin to
 * list. KV has no cross-key transactions, so a write that updates one key
 * and not the other produces either a tool that's listed but not callable,
 * or callable but not listed. `approveTool` and `declineTool` below own
 * keeping both in sync.
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

/** Just the approved manifests from an entry, in the shape callers already use. */
export function approvedManifests(entry: RegistryEntry | null): ToolManifest[] {
  if (!entry) return [];
  return entry.tools.filter((t) => t.status === "approved").map((t) => t.manifest);
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
 * per-origin entry whenever a tool is approved — this code path only reads
 * it today, and nothing writes it yet, so it always misses.
 */
export async function getApprovedManifestByName(
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

/**
 * Add newly generated tools as drafts. A tool name already present in the
 * entry — draft, approved, or declined — is skipped: automatic generation
 * never overwrites a human's prior decision, and a re-run that finds the
 * same tool again is a no-op for it.
 */
export async function recordDraftTools(
  kv: KvLike,
  origin: string,
  manifests: ToolManifest[],
): Promise<RegistryEntry> {
  const existing = await getRegistryEntry(kv, origin);
  const existingNames = new Set((existing?.tools ?? []).map((t) => t.manifest.name));
  const now = Date.now();
  const additions: GeneratedTool[] = manifests
    .filter((m) => !existingNames.has(m.name))
    .map((m) => ({ manifest: m, status: "draft", generatedAt: now }));
  const entry: RegistryEntry = { tools: [...(existing?.tools ?? []), ...additions] };
  await kv.put(originKey(origin), JSON.stringify(entry));
  return entry;
}

/**
 * Approve one tool by name. Writes the per-origin entry (source of truth for
 * listing) and the `tool:<name>` key (source of truth for `manifestFor`'s
 * O(1) lookup) — two KV writes, not a transaction; if the second fails the
 * tool shows as approved in listings but `manifestFor` still misses it until
 * a retry. Acceptable for a human-paced, one-tool-at-a-time action.
 *
 * The manifest is read out with `find` before the map rather than captured
 * from inside the map callback: a `let` assigned in a nested closure loses
 * its narrowing, and the `tool:<name>` write must not be reachable with an
 * unnarrowed value.
 */
export async function approveTool(
  kv: KvLike,
  origin: string,
  name: string,
): Promise<RegistryEntry | null> {
  const entry = await getRegistryEntry(kv, origin);
  if (!entry) return null;
  const approvedManifest = entry.tools.find((t) => t.manifest.name === name)?.manifest;
  const now = Date.now();
  const tools = entry.tools.map((t) =>
    t.manifest.name === name ? { ...t, status: "approved" as const, approvedAt: now } : t,
  );
  const next: RegistryEntry = { tools };
  await kv.put(originKey(origin), JSON.stringify(next));
  if (approvedManifest) {
    await kv.put(toolKey(name), JSON.stringify(approvedManifest));
  }
  return next;
}

/** Decline one tool by name. No `tool:<name>` key is ever written for it. */
export async function declineTool(
  kv: KvLike,
  origin: string,
  name: string,
): Promise<RegistryEntry | null> {
  const entry = await getRegistryEntry(kv, origin);
  if (!entry) return null;
  const tools = entry.tools.map((t) =>
    t.manifest.name === name ? { ...t, status: "declined" as const } : t,
  );
  const next: RegistryEntry = { tools };
  await kv.put(originKey(origin), JSON.stringify(next));
  // Decline is also the revoke path: a tool approved earlier already has a
  // `tool:<name>` key, and `getApprovedManifestByName` resolves from that key
  // alone without re-reading the per-origin status. Leaving it behind would
  // show the tool as declined in every listing while it stayed callable by
  // name. Deleting an absent key is a no-op, so a first refusal costs nothing.
  await kv.delete(toolKey(name));
  return next;
}
