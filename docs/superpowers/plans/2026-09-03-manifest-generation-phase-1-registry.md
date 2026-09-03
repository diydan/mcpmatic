# Manifest Generation — Phase 1: Registry-Backed Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every manifest-resolution call site (`manifestFor`, `originOfTool`, `buildToolList`) able to read a tool from a KV-backed registry in addition to the static `shared/stores.ts` list, with the registry always empty in this phase. Behavior is identical to today — this phase proves the plumbing before Phase 2 ever writes to it.

**Architecture:** A new `MANIFEST_REGISTRY` KV namespace, keyed two ways — `origin:<origin>` holds every tool ever generated for that origin (any status, for listing) and `tool:<name>` holds a blessed manifest directly (for O(1) name lookup, the shape every existing caller already uses). `worker/manifest-registry.ts` owns both key shapes and takes a minimal `KvLike` interface rather than a full `KVNamespace`, mirroring how `worker/is-private-url.ts` takes a bare `Resolve4` function instead of `Env` — so every test in this plan passes a plain object, never a real binding. `manifestFor`/`originOfTool`/`buildToolList` become `async`: check the static list first (no KV round-trip for a demo-store tool), fall through to the registry only on a miss.

**Tech Stack:** Cloudflare Workers + Durable Objects (existing), TypeScript, vitest, Cloudflare KV.

**Spec:** `docs/superpowers/specs/2026-09-03-manifest-generation-design.md` (Storage section). This plan implements only the read side of that section; Phase 2 (a separate plan) implements generation, the write side, and the review/bless UI.

## Global Constraints

1. **No behavior change in this phase.** The registry is never written to here. Every existing test that asserts a static tool's resolution must still pass with the same result, just `await`ed.
2. **`manifestFor`/`originOfTool`/`buildToolList` take an optional `kv` parameter, not a full `Env`.** A caller with no KV binding (or a test with no registry concerns) omits it and gets static-only resolution — no crash, no `Env` type threaded through modules that don't otherwise need it.
3. **Static lookup always wins and never touches KV.** A tool name that exists in `shared/stores.ts`'s manifests resolves from the in-memory `Map` built at module load; the registry is consulted only on a static miss.
4. **No changes to the audit table shape** (`{origin, tool, field_names, ts}`, no value column). This phase doesn't touch the audit table at all, but it's worth restating since later phases might reach for it.
5. **Bash commands are run from the repo root** unless stated otherwise.
6. **Every commit message follows Conventional Commits** (`feat:`, `fix:`, `test:`, `chore:`, `docs:`, plus scoped forms like `feat(registry):`) and ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

New files:

| File | Purpose |
|---|---|
| `worker/manifest-registry.ts` | `GeneratedTool`/`RegistryEntry`/`KvLike` types, `getRegistryEntry`, `blessedManifests`, `getBlessedManifestByName` (read-only in this phase) |
| `tests/manifest-registry.test.ts` | Unit tests for the above, against a fake `KvLike` |

Modified files:

| File | Change |
|---|---|
| `worker/manifests.ts` | `manifestFor`/`originOfTool` become `async`, take optional `kv: KvLike` |
| `worker/mcp/tools.ts` | `buildToolList` becomes `async`, takes optional `kv: KvLike` |
| `worker/session-do.ts` | 6 call sites `await` the now-async functions (verified via grep during the final review — this table originally undercounted by one); `listTools()` awaits `buildToolList` and passes `this.env.MANIFEST_REGISTRY` |
| `wrangler.jsonc` | Add `MANIFEST_REGISTRY` KV binding |
| `worker-configuration.d.ts` | Add `MANIFEST_REGISTRY?: KVNamespace` to `Cloudflare.Env` |
| `tests/mcp-do-call.test.ts` | `await originOfTool(...)` |
| `tests/mcp-do.test.ts` | `await buildToolList(...)` |
| `tests/mcp-tools.test.ts` | `await buildToolList(...)` (4 call sites) |

---

### Task 1: Registry types and read-only KV helpers

**Files:**
- Create: `worker/manifest-registry.ts`
- Test: `tests/manifest-registry.test.ts`

**Interfaces:**
- Consumes: `ToolManifest` from `../shared/manifest`
- Produces: `GeneratedToolStatus`, `GeneratedTool`, `RegistryEntry`, `KvLike`, `getRegistryEntry(kv: KvLike, origin: string): Promise<RegistryEntry | null>`, `blessedManifests(entry: RegistryEntry | null): ToolManifest[]`, `getBlessedManifestByName(kv: KvLike, name: string): Promise<ToolManifest | undefined>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/manifest-registry.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  getRegistryEntry,
  blessedManifests,
  getBlessedManifestByName,
  type RegistryEntry,
  type KvLike,
} from "../worker/manifest-registry";
import type { ToolManifest } from "../shared/manifest";

const TOOL: ToolManifest = {
  name: "search_widgets_on_example_com",
  description: "search widgets",
  origin: "https://example.com",
  inputSchema: { type: "object", properties: {} },
  steps: [{ action: "goto", url: "https://example.com" }],
};

function fakeKv(store: Record<string, string>): KvLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async () => {}),
  };
}

describe("getRegistryEntry", () => {
  it("returns null when the origin has no entry", async () => {
    const kv = fakeKv({});
    expect(await getRegistryEntry(kv, "https://example.com")).toBeNull();
  });

  it("parses a stored entry", async () => {
    const entry: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "blessed", generatedAt: 1, blessedAt: 2 }],
    };
    const kv = fakeKv({ "origin:https://example.com": JSON.stringify(entry) });
    expect(await getRegistryEntry(kv, "https://example.com")).toEqual(entry);
  });

  it("returns null on malformed JSON rather than throwing", async () => {
    const kv = fakeKv({ "origin:https://example.com": "{not json" });
    expect(await getRegistryEntry(kv, "https://example.com")).toBeNull();
  });

  it("returns null when the stored value has no tools array", async () => {
    const kv = fakeKv({ "origin:https://example.com": JSON.stringify({ foo: 1 }) });
    expect(await getRegistryEntry(kv, "https://example.com")).toBeNull();
  });
});

describe("blessedManifests", () => {
  it("returns an empty array for a null entry", () => {
    expect(blessedManifests(null)).toEqual([]);
  });

  it("keeps only blessed tools, unwrapped to ToolManifest", () => {
    const entry: RegistryEntry = {
      tools: [
        { manifest: TOOL, status: "blessed", generatedAt: 1, blessedAt: 2 },
        { manifest: { ...TOOL, name: "draft_tool" }, status: "draft", generatedAt: 1 },
        { manifest: { ...TOOL, name: "declined_tool" }, status: "declined", generatedAt: 1 },
      ],
    };
    expect(blessedManifests(entry)).toEqual([TOOL]);
  });
});

describe("getBlessedManifestByName", () => {
  it("returns undefined when there is no tool key", async () => {
    const kv = fakeKv({});
    expect(await getBlessedManifestByName(kv, "search_widgets_on_example_com")).toBeUndefined();
  });

  it("parses the stored manifest", async () => {
    const kv = fakeKv({ "tool:search_widgets_on_example_com": JSON.stringify(TOOL) });
    expect(await getBlessedManifestByName(kv, "search_widgets_on_example_com")).toEqual(TOOL);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/manifest-registry.test.ts`
Expected: FAIL — `worker/manifest-registry.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// worker/manifest-registry.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/manifest-registry.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/manifest-registry.ts tests/manifest-registry.test.ts
git commit -m "feat(registry): add read-only manifest registry KV helpers"
```

---

### Task 2: Provision the KV namespace and bind it

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `worker-configuration.d.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Env.MANIFEST_REGISTRY?: KVNamespace`, available to every worker module via the existing `Env` global

- [ ] **Step 1: Create the namespace**

Run: `pnpm wrangler kv namespace create MANIFEST_REGISTRY`

This prints an `id`. Copy it — the next step needs it.

- [ ] **Step 2: Add the binding to `wrangler.jsonc`**

```jsonc
  "kv_namespaces": [
    { "binding": "OAUTH_TOKENS", "id": "4c1c248d70a8467287d8e693877ab4bb" },
    { "binding": "MANIFEST_REGISTRY", "id": "<id from Step 1>" }
  ],
```

- [ ] **Step 3: Add the type to `worker-configuration.d.ts`**

```typescript
    OAUTH_TOKENS: KVNamespace;
    /**
     * Generated (and human-blessed) WebMCP manifests, keyed two ways:
     * `origin:<origin>` for the full per-origin listing, `tool:<name>` for
     * O(1) lookup by tool name. See worker/manifest-registry.ts.
     */
    MANIFEST_REGISTRY?: KVNamespace;
```

(inserted directly below the existing `OAUTH_TOKENS: KVNamespace;` line — optional, like `BROWSER?: Fetcher` and `AI?: {...}` above it, so a deploy or test environment with no binding configured doesn't fail to type-check.)

- [ ] **Step 4: Verify the type-check picks it up**

Run: `pnpm typecheck`
Expected: PASS (nothing references `MANIFEST_REGISTRY` yet, so this only proves the declaration itself is well-formed)

- [ ] **Step 5: Commit**

```bash
git add wrangler.jsonc worker-configuration.d.ts
git commit -m "chore(registry): provision and bind the MANIFEST_REGISTRY KV namespace"
```

---

### Task 3: Make `manifestFor` and `originOfTool` registry-aware

**Files:**
- Modify: `worker/manifests.ts`
- Test: `tests/manifests.test.ts` (new)

**Interfaces:**
- Consumes: `getBlessedManifestByName`, `type KvLike` from `./manifest-registry` (Task 1)
- Produces: `manifestFor(name: string, kv?: KvLike): Promise<ToolManifest | undefined>`, `originOfTool(name: string, kv?: KvLike): Promise<string | null>` — same names, now `async`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/manifests.test.ts
import { describe, expect, it, vi } from "vitest";
import { manifestFor, originOfTool } from "../worker/manifests";
import type { KvLike } from "../worker/manifest-registry";
import type { ToolManifest } from "../shared/manifest";

const GENERATED: ToolManifest = {
  name: "search_widgets_on_example_com",
  description: "search widgets",
  origin: "https://example.com",
  inputSchema: { type: "object", properties: {} },
  steps: [{ action: "goto", url: "https://example.com" }],
};

function fakeKv(store: Record<string, string>): KvLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async () => {}),
  };
}

describe("manifestFor", () => {
  it("resolves a static (hand-authored) tool without touching kv", async () => {
    const kv = fakeKv({});
    const m = await manifestFor("search_flights_on_kayak_com", kv);
    expect(m?.origin).toBe("https://www.kayak.com");
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("resolves a registry-backed tool on a static miss", async () => {
    const kv = fakeKv({ "tool:search_widgets_on_example_com": JSON.stringify(GENERATED) });
    const m = await manifestFor("search_widgets_on_example_com", kv);
    expect(m).toEqual(GENERATED);
  });

  it("returns undefined when kv is omitted and the tool isn't static", async () => {
    expect(await manifestFor("search_widgets_on_example_com")).toBeUndefined();
  });

  it("returns undefined for an unknown tool even with kv present", async () => {
    const kv = fakeKv({});
    expect(await manifestFor("nonexistent_tool", kv)).toBeUndefined();
  });
});

describe("originOfTool", () => {
  it("returns null for spine tools", async () => {
    expect(await originOfTool("get_page_state")).toBeNull();
    expect(await originOfTool("navigate_to")).toBeNull();
    expect(await originOfTool("list_remote_tools")).toBeNull();
    expect(await originOfTool("call_remote_tool")).toBeNull();
    expect(await originOfTool("list_available_origins")).toBeNull();
  });

  it("returns the manifest origin for a static tool", async () => {
    expect(await originOfTool("search_flights_on_kayak_com")).toBe("https://www.kayak.com");
  });

  it("returns the manifest origin for a registry-backed tool", async () => {
    const kv = fakeKv({ "tool:search_widgets_on_example_com": JSON.stringify(GENERATED) });
    expect(await originOfTool("search_widgets_on_example_com", kv)).toBe("https://example.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/manifests.test.ts`
Expected: FAIL — `manifestFor`/`originOfTool` currently return non-Promise values, so `await` on them "succeeds" trivially but the registry-backed assertions fail (no such overload exists yet / kv argument is ignored).

- [ ] **Step 3: Rewrite the implementation**

```typescript
// worker/manifests.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/manifests.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/manifests.ts tests/manifests.test.ts
git commit -m "feat(registry): make manifestFor/originOfTool registry-aware"
```

---

### Task 4: Make `buildToolList` registry-aware

**Files:**
- Modify: `worker/mcp/tools.ts`
- Modify: `tests/mcp-do.test.ts`
- Modify: `tests/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `getRegistryEntry`, `blessedManifests`, `type KvLike` from `../manifest-registry` (Task 1)
- Produces: `buildToolList(consented: ReadonlySet<string>, kv?: KvLike): Promise<McpToolDescriptor[]>` — same name, now `async`. `manifestByName` is unchanged (static-only; its own doc comment already says "Used by tests to assert which manifests are in scope" — it is never called from runtime code, only from test files, so it stays synchronous).

- [ ] **Step 1: Update the existing tests to await**

`tests/mcp-do.test.ts` — change both call sites:

```typescript
    const list = await buildToolList(new Set());
```

```typescript
    const list = await buildToolList(new Set(["https://www.kayak.com"]));
```

`tests/mcp-tools.test.ts` — change all four call sites the same way (`await buildToolList(...)`), and change each surrounding `it("...", () => {` to `it("...", async () => {` (vitest needs the test body itself to be async to `await` inside it).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/mcp-do.test.ts tests/mcp-tools.test.ts`
Expected: FAIL — `await` on a non-Promise is harmless, but a TypeScript error appears once Step 3 below hasn't landed yet only if you run typecheck; at the vitest-run level these still pass today because `await` on a sync value is a no-op. This step is here so the diff order matches TDD even though the red bar is really the `pnpm typecheck` in Step 4, not `vitest run`. Proceed to Step 3.

- [ ] **Step 3: Add a new registry-backed assertion**

Append to `tests/mcp-tools.test.ts`:

```typescript
import { blessedManifests, type RegistryEntry } from "../worker/manifest-registry";
import type { ToolManifest } from "../../shared/manifest";
```

(add these two imports at the top, alongside the existing ones)

```typescript
describe("buildToolList with a registry", () => {
  it("includes a blessed generated tool for a consented origin", async () => {
    const generated: ToolManifest = {
      name: "search_widgets_on_example_com",
      description: "search widgets",
      origin: "https://example.com",
      inputSchema: { type: "object", properties: {} },
      steps: [{ action: "goto", url: "https://example.com" }],
    };
    const entry: RegistryEntry = {
      tools: [{ manifest: generated, status: "blessed", generatedAt: 1, blessedAt: 2 }],
    };
    const kv = {
      get: async (key: string) =>
        key === "origin:https://example.com" ? JSON.stringify(entry) : null,
      put: async () => {},
    };
    const list = await buildToolList(new Set(["https://example.com"]), kv);
    expect(list.some((t) => t.name === "search_widgets_on_example_com")).toBe(true);
  });

  it("omits a draft (unblessed) generated tool", async () => {
    const generated: ToolManifest = {
      name: "search_widgets_on_example_com",
      description: "search widgets",
      origin: "https://example.com",
      inputSchema: { type: "object", properties: {} },
      steps: [{ action: "goto", url: "https://example.com" }],
    };
    const entry: RegistryEntry = {
      tools: [{ manifest: generated, status: "draft", generatedAt: 1 }],
    };
    const kv = {
      get: async (key: string) =>
        key === "origin:https://example.com" ? JSON.stringify(entry) : null,
      put: async () => {},
    };
    const list = await buildToolList(new Set(["https://example.com"]), kv);
    expect(list.some((t) => t.name === "search_widgets_on_example_com")).toBe(false);
  });

  it("ignores an unconsented origin's registry entry entirely", async () => {
    const kv = {
      get: async () => {
        throw new Error("must not be called for an unconsented origin");
      },
      put: async () => {},
    };
    const list = await buildToolList(new Set(), kv);
    expect(list.map((t) => t.name)).not.toContain("search_widgets_on_example_com");
  });
});
```

- [ ] **Step 4: Rewrite `buildToolList`**

```typescript
// worker/mcp/tools.ts — replace the existing buildToolList
import { getRegistryEntry, blessedManifests, type KvLike } from "../manifest-registry";

export async function buildToolList(
  consented: ReadonlySet<string>,
  kv?: KvLike,
): Promise<McpToolDescriptor[]> {
  const out: McpToolDescriptor[] = [...SPINE];
  for (const m of MANIFESTS) {
    if (!consented.has(m.origin)) continue;
    out.push({
      name: m.name,
      description: m.description,
      inputSchema: m.inputSchema as unknown as Record<string, unknown>,
    });
  }
  if (kv) {
    for (const origin of consented) {
      const entry = await getRegistryEntry(kv, origin);
      for (const m of blessedManifests(entry)) {
        out.push({
          name: m.name,
          description: m.description,
          inputSchema: m.inputSchema as unknown as Record<string, unknown>,
        });
      }
    }
  }
  return out;
}
```

(add the `getRegistryEntry, blessedManifests, type KvLike` import at the top of the file, alongside the existing `import { MANIFESTS } from "../manifests";`)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/mcp-do.test.ts tests/mcp-tools.test.ts`
Expected: PASS (all cases, including the 3 new ones)

- [ ] **Step 6: Commit**

```bash
git add worker/mcp/tools.ts tests/mcp-do.test.ts tests/mcp-tools.test.ts
git commit -m "feat(registry): make buildToolList registry-aware"
```

---

### Task 5: Thread `await` through every `session-do.ts` call site

**Files:**
- Modify: `worker/session-do.ts:257`, `:259`, `:457-458`, `:634`, and `listTools()`
- Modify: `tests/mcp-do-call.test.ts`

**Interfaces:**
- Consumes: `manifestFor`, `originOfTool` (Task 3), `buildToolList` (Task 4) — all now `async`
- Produces: no new exports; every existing caller inside `SessionDO` now awaits and passes `this.env.MANIFEST_REGISTRY`

- [ ] **Step 1: Update `tests/mcp-do-call.test.ts`**

```typescript
import { describe, expect, it } from "vitest";
import { manifestByName } from "../worker/mcp/tools";
import { originOfTool } from "../worker/manifests";

describe("MCP callTool contract helpers", () => {
  it("manifestByName finds a known manifest", () => {
    const m = manifestByName("search_flights_on_kayak_com");
    expect(m?.origin).toBe("https://www.kayak.com");
  });

  it("originOfTool returns the manifest origin", async () => {
    expect(await originOfTool("search_flights_on_kayak_com")).toBe("https://www.kayak.com");
  });

  it("originOfTool returns null for spine tools", async () => {
    expect(await originOfTool("get_page_state")).toBeNull();
    expect(await originOfTool("navigate_to")).toBeNull();
  });
});
```

(`manifestByName` stays sync — untouched. Only the two `originOfTool` tests gain `async`/`await`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm typecheck`
Expected: FAIL — `worker/session-do.ts` calls `manifestFor(name)?.fillsFrom` etc. on what is now a `Promise`, which has no `.fillsFrom`.

- [ ] **Step 3: Fix `callTool` (around line 257-259)**

Before:

```typescript
    const fieldNames = manifestFor(name)?.fillsFrom ?? [];
    const auditOrigin =
      originOfTool(name) ?? this.currentOrigin() ?? "";
    this.recordAudit(auditOrigin, name, fieldNames);
```

After:

```typescript
    const fieldNames = (await manifestFor(name, this.env.MANIFEST_REGISTRY))?.fillsFrom ?? [];
    const auditOrigin =
      (await originOfTool(name, this.env.MANIFEST_REGISTRY)) ?? this.currentOrigin() ?? "";
    this.recordAudit(auditOrigin, name, fieldNames);
```

- [ ] **Step 4: Fix `onToolExec` (around line 456-458)**

Before:

```typescript
    const fieldNames = manifestFor(name)?.fillsFrom ?? [];
    this.recordAudit(originOfTool(name) ?? this.currentOrigin() ?? "", name, fieldNames);
```

After:

```typescript
    const fieldNames = (await manifestFor(name, this.env.MANIFEST_REGISTRY))?.fillsFrom ?? [];
    this.recordAudit(
      (await originOfTool(name, this.env.MANIFEST_REGISTRY)) ?? this.currentOrigin() ?? "",
      name,
      fieldNames,
    );
```

- [ ] **Step 5: Fix `runTool`'s proxied-tool fallback (around line 634)**

Before:

```typescript
    const manifest = manifestFor(name);
    if (!manifest) return { ok: false, text: `unknown tool ${name}` };
```

After:

```typescript
    const manifest = await manifestFor(name, this.env.MANIFEST_REGISTRY);
    if (!manifest) return { ok: false, text: `unknown tool ${name}` };
```

- [ ] **Step 6: Fix `listTools()`**

Before:

```typescript
  async listTools(): Promise<ToolSchema[]> {
    const consented = new Set(this.readConsent());
    return buildToolList(consented) as unknown as ToolSchema[];
  }
```

After:

```typescript
  async listTools(): Promise<ToolSchema[]> {
    const consented = new Set(this.readConsent());
    return (await buildToolList(consented, this.env.MANIFEST_REGISTRY)) as unknown as ToolSchema[];
  }
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — no regressions. The registry is still empty everywhere in production, so every existing assertion resolves exactly as it did before this plan.

- [ ] **Step 8: Commit**

```bash
git add worker/session-do.ts tests/mcp-do-call.test.ts
git commit -m "feat(registry): await registry-aware manifest resolution in SessionDO"
```

---

## Self-Review Notes

- **Spec coverage:** this plan implements only the Storage section's read path from the design spec. Generation, the write path, the trigger flow, and the review/bless UI are Phase 2 — see the spec's Storage/Trigger flow/Review & bless sections, all still open.
- **Left deliberately unchanged in this phase:** `worker/session-do.ts:498` (`known: MANIFESTS.map(...)` inside `list_available_origins`) and `:885` (`setAutonomous`'s catalog) — both static-only. The registry is empty in this phase, so this is behavior-neutral; whether the "known origins" catalog should grow to include registry-backed origins is a Phase 2 question, not resolved here.
- **`manifestByName`** (`worker/mcp/tools.ts`) is untouched — it's a test-only helper over the static list, never called from runtime code.

## Outcome

Shipped via subagent-driven-development: 5 tasks, each individually reviewed clean (zero Critical/Important findings across all five), then a final whole-branch review on the most capable model. That review verified the core claims directly rather than trusting reports — ran `wrangler kv namespace list` to confirm the KV namespace was real, grepped every `.put(` call to confirm the registry is genuinely never written to in this phase, grepped every consumer of `manifestFor`/`originOfTool`/`buildToolList` to confirm none were left un-awaited — and found 4 real Important issues invisible to any single task's review because they only exist in the composition:

1. `manifestFor` had no spine-tool short-circuit (only `originOfTool` did), so every `get_page_state` call — the most-invoked tool in the system — fell through to a guaranteed-miss KV read once the binding existed.
2. `callTool`/`onToolExec` each called both `manifestFor` and `originOfTool` for the same name, doubling the waste.
3. `buildToolList` had no dedup between the static and registry loops, and no check that a registry manifest's own `.origin` matched the key it was read from.
4. `getBlessedManifestByName` did zero shape validation, unlike its sibling `getRegistryEntry`.

All four fixed in one fix wave, verified by a scoped re-review (all 6 findings — the 4 above plus 2 Minors — confirmed ADDRESSED, no new breakage), merged to `main` locally as `db3476d`. Full details: git log on `main` from `15fa08d..db3476d`.

**One process note worth keeping:** the fix wave's own dispatch cited `shared/manifest.ts`'s `ALWAYS_ON_TOOLS` from a stale recollection (a different, uncommitted local checkout, not this worktree) — it had 3 entries in this worktree, not the 5 the fix assumed. The implementer caught it, correctly declined to guess, and reported `DONE_WITH_CONCERNS` rather than silently shipping a partial fix. Resolved by the controller directly (verified `ALWAYS_ON_TOOLS` had zero other consumers, widened it, added a covering test) rather than another subagent round for a 2-line change.

**Not carried into Phase 1 — explicitly for Phase 2:** the façade side (`src/pages/Session.tsx`, `src/lib/register-all.ts`) still reads only the static `allManifests()` list. `worker/mcp/tools.ts`'s own doc comment asserts the façade and the MCP surface expose the same tool names — Phase 2 will break that invariant the moment a generated tool is blessed, unless the façade is widened too. See the Phase 2 plan's Open Questions.

**Phase 2 plan:** `docs/superpowers/plans/2026-09-03-manifest-generation-phase-2-generation-and-bless.md`
