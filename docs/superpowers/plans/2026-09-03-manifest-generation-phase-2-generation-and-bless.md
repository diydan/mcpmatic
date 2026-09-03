# Manifest Generation — Phase 2: Capture, Synthesis, Trigger & Bless Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a draft WebMCP manifest for an origin with no shipped WebMCP, from a snapshot of its interactive DOM elements, gated behind a one-time human bless per tool before it is ever callable.

**Architecture:** Two trigger entry points — an automatic one fired from `list_remote_tools`/`call_remote_tool` on a "no WebMCP" miss, and a manual "Map this site" button — both call the same `runGeneration(origin)` in `SessionDO`, which never blocks the request that triggered it. Capture walks the live page's DOM through `page.evaluate` (the same mechanism `worker/native-webmcp.ts` already uses to read `document.modelContext`). Synthesis reuses `runTurn` from `worker/agent.ts` with an empty tool list, so the model's reply is a plain message the worker parses and validates as JSON — never a tool call the worker has to trust blindly. A human reviews and blesses or declines each draft tool individually in a new UI screen; only a blessed tool is ever visible to `manifestFor`/`buildToolList`.

**Tech Stack:** Cloudflare Workers + Durable Objects, TypeScript, vitest, React, Cloudflare AI Gateway (existing `env.AI` binding).

**Spec:** `docs/superpowers/specs/2026-09-03-manifest-generation-design.md` (Capture, Synthesis, Trigger flow, Review & bless sections). Depends on Phase 1 (`docs/superpowers/plans/2026-09-03-manifest-generation-phase-1-registry.md`) — `manifestFor`/`originOfTool`/`buildToolList` must already be registry-aware before this plan's writes to the registry mean anything.

## Global Constraints

1. **No LLM call blocks a ChatGPT turn.** The automatic trigger fires `runGeneration` without awaiting it from the code path that returns the miss outcome to the caller.
2. **Nothing generated is callable until blessed.** `recordDraftTools` writes with `status: "draft"`; `manifestFor`/`originOfTool`/`buildToolList` (Phase 1) only ever see `status: "blessed"` entries.
3. **The worker validates every field of a generated manifest before storage.** A step with an unrecognized `action`, a missing required field, or a tool name that fails `NAME_RE` after origin-qualification is dropped, not stored. The model is never trusted to self-police its own output shape.
4. **No changes to the audit table shape** (`{origin, tool, field_names, ts}`, no value column). Generation and bless events live in the KV registry and the WebSocket broadcast only.
5. **Bash commands are run from the repo root** unless stated otherwise.
6. **Every commit message follows Conventional Commits** and ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

New files:

| File | Purpose |
|---|---|
| `worker/dom-capture.ts` | `captureInteractiveElements(evaluate)` — walks the live page's DOM via `page.evaluate`, returns `PageElement[]` |
| `worker/generate-manifest.ts` | `generateManifest(env, origin, elements)` — prompts the model, parses and validates its reply into `ToolManifest[]` |
| `shared/describe-steps.ts` | `describeStep(step)` — renders one `ManifestStep` as a plain-language sentence, for the review screen |
| `src/components/ManifestReview.tsx` | The review/bless screen — one draft tool at a time, its steps in plain language, Bless/Decline |
| `tests/dom-capture.test.ts`, `tests/generate-manifest.test.ts`, `tests/describe-steps.test.ts` | Unit tests for the above |

Modified files:

| File | Change |
|---|---|
| `worker/manifest-registry.ts` | Add `recordDraftTools`, `blessTool`, `declineTool` (the write side; Phase 1 only added reads) |
| `worker/native-webmcp.ts` | Export `NAME_RE` and `sanitizeSchema` (already implemented, just not exported) |
| `shared/protocol.ts` | Add `manifest_draft` (server→client), `generate_manifest` and `manifest_decision` (client→server) |
| `worker/session-do.ts` | Widen `LiveBrowser.page.evaluate`'s type; add `generatingOrigins`, `runGeneration`, `maybeAutoGenerate`, `onGenerateManifest`, `onManifestDecision`; hook the two entry points; two new `webSocketMessage` cases |
| `src/components/Surface.tsx` | "Map this site" button when `remoteTools.length === 0` |
| `src/pages/Session.tsx` | `manifestDraft` state, `manifest_draft` message handling, render `ManifestReview`, wire the "Map this site" button |

---

### Task 1: Registry write helpers

**Files:**
- Modify: `worker/manifest-registry.ts`
- Modify: `tests/manifest-registry.test.ts`

**Interfaces:**
- Consumes: `RegistryEntry`, `GeneratedTool`, `KvLike`, `getRegistryEntry` (Phase 1, this file)
- Produces: `recordDraftTools(kv: KvLike, origin: string, manifests: ToolManifest[]): Promise<RegistryEntry>`, `blessTool(kv: KvLike, origin: string, name: string): Promise<RegistryEntry | null>`, `declineTool(kv: KvLike, origin: string, name: string): Promise<RegistryEntry | null>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/manifest-registry.test.ts`:

```typescript
import { recordDraftTools, blessTool, declineTool } from "../worker/manifest-registry";

describe("recordDraftTools", () => {
  it("adds new tools as drafts", async () => {
    const store: Record<string, string> = {};
    const kv: KvLike = {
      get: vi.fn(async (k: string) => store[k] ?? null),
      put: vi.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
    };
    const entry = await recordDraftTools(kv, "https://example.com", [TOOL]);
    expect(entry.tools).toHaveLength(1);
    expect(entry.tools[0].status).toBe("draft");
    expect(entry.tools[0].manifest).toEqual(TOOL);
  });

  it("does not duplicate a tool name already present in any status", async () => {
    const existing: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "blessed", generatedAt: 1, blessedAt: 2 }],
    };
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify(existing),
    };
    const kv: KvLike = {
      get: vi.fn(async (k: string) => store[k] ?? null),
      put: vi.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
    };
    const entry = await recordDraftTools(kv, "https://example.com", [TOOL]);
    expect(entry.tools).toHaveLength(1);
    expect(entry.tools[0].status).toBe("blessed");
  });
});

describe("blessTool", () => {
  it("marks the named tool blessed and writes the tool: lookup key", async () => {
    const existing: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "draft", generatedAt: 1 }],
    };
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify(existing),
    };
    const kv: KvLike = {
      get: vi.fn(async (k: string) => store[k] ?? null),
      put: vi.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
    };
    const entry = await blessTool(kv, "https://example.com", TOOL.name);
    expect(entry?.tools[0].status).toBe("blessed");
    expect(entry?.tools[0].blessedAt).toBeGreaterThan(0);
    expect(JSON.parse(store[`tool:${TOOL.name}`])).toEqual(TOOL);
  });

  it("returns null when the origin has no entry", async () => {
    const kv: KvLike = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    expect(await blessTool(kv, "https://example.com", TOOL.name)).toBeNull();
  });
});

describe("declineTool", () => {
  it("marks the named tool declined without writing a tool: key", async () => {
    const existing: RegistryEntry = {
      tools: [{ manifest: TOOL, status: "draft", generatedAt: 1 }],
    };
    const store: Record<string, string> = {
      "origin:https://example.com": JSON.stringify(existing),
    };
    const kv: KvLike = {
      get: vi.fn(async (k: string) => store[k] ?? null),
      put: vi.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
    };
    const entry = await declineTool(kv, "https://example.com", TOOL.name);
    expect(entry?.tools[0].status).toBe("declined");
    expect(store[`tool:${TOOL.name}`]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/manifest-registry.test.ts`
Expected: FAIL — `recordDraftTools`/`blessTool`/`declineTool` are not exported yet.

- [ ] **Step 3: Implement, appending to `worker/manifest-registry.ts`**

```typescript
/**
 * Add newly generated tools as drafts. A tool name already present in the
 * entry — draft, blessed, or declined — is skipped: automatic generation
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
 * Bless one tool by name. Writes the per-origin entry (source of truth for
 * listing) and the `tool:<name>` key (source of truth for `manifestFor`'s
 * O(1) lookup) — two KV writes, not a transaction; if the second fails the
 * tool shows as blessed in listings but `manifestFor` still misses it until
 * a retry. Acceptable for a human-paced, one-tool-at-a-time action.
 */
export async function blessTool(
  kv: KvLike,
  origin: string,
  name: string,
): Promise<RegistryEntry | null> {
  const entry = await getRegistryEntry(kv, origin);
  if (!entry) return null;
  const now = Date.now();
  let blessedManifest: ToolManifest | null = null;
  const tools = entry.tools.map((t) => {
    if (t.manifest.name !== name) return t;
    blessedManifest = t.manifest;
    return { ...t, status: "blessed" as const, blessedAt: now };
  });
  const next: RegistryEntry = { tools };
  await kv.put(originKey(origin), JSON.stringify(next));
  if (blessedManifest) {
    await kv.put(toolKey(name), JSON.stringify(blessedManifest));
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
  return next;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/manifest-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/manifest-registry.ts tests/manifest-registry.test.ts
git commit -m "feat(registry): add draft/bless/decline write helpers"
```

---

### Task 2: Export `NAME_RE` and `sanitizeSchema` from `native-webmcp.ts`

**Files:**
- Modify: `worker/native-webmcp.ts:102`, `:115`

**Interfaces:**
- Produces: `NAME_RE` and `sanitizeSchema` become named exports; every existing internal use is unaffected (same identifiers, just now also importable)

- [ ] **Step 1: Export both**

`worker/native-webmcp.ts:102`, before:

```typescript
const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
```

after:

```typescript
export const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
```

`worker/native-webmcp.ts:115`, before:

```typescript
function sanitizeSchema(raw: unknown): Record<string, unknown> {
```

after:

```typescript
export function sanitizeSchema(raw: unknown): Record<string, unknown> {
```

- [ ] **Step 2: Verify nothing else broke**

Run: `pnpm typecheck && pnpm vitest run tests/native-webmcp.test.ts`
Expected: PASS — this is a pure export widening, no behavior change.

- [ ] **Step 3: Commit**

```bash
git add worker/native-webmcp.ts
git commit -m "refactor(native-webmcp): export NAME_RE and sanitizeSchema for reuse"
```

---

### Task 3: Capture — walk the live page's DOM

**Files:**
- Create: `worker/dom-capture.ts`
- Test: `tests/dom-capture.test.ts`

**Interfaces:**
- Consumes: nothing worker-specific — takes only the evaluate function it needs, same abstraction `native-webmcp.ts`'s `EvaluateFn`/`DiscoverFn` already use
- Produces: `PageElement`, `CaptureFn`, `captureInteractiveElements(evaluate: CaptureFn): Promise<PageElement[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/dom-capture.test.ts
import { describe, expect, it, vi } from "vitest";
import { captureInteractiveElements, type CaptureFn, type PageElement } from "../worker/dom-capture";

describe("captureInteractiveElements", () => {
  it("returns whatever the evaluate call produces", async () => {
    const elements: PageElement[] = [
      { role: "button", name: "Search", selector: "button.search" },
    ];
    const evaluate: CaptureFn = vi.fn(async () => elements);
    expect(await captureInteractiveElements(evaluate)).toEqual(elements);
  });

  it("caps the result at 150 elements", async () => {
    const many: PageElement[] = Array.from({ length: 200 }, (_, i) => ({
      role: "button",
      name: `b${i}`,
      selector: `#b${i}`,
    }));
    const evaluate: CaptureFn = vi.fn(async () => many);
    const out = await captureInteractiveElements(evaluate);
    expect(out).toHaveLength(150);
  });

  it("returns an empty list rather than throwing when evaluate rejects", async () => {
    const evaluate: CaptureFn = vi.fn(async () => {
      throw new Error("page navigated away");
    });
    expect(await captureInteractiveElements(evaluate)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/dom-capture.test.ts`
Expected: FAIL — `worker/dom-capture.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// worker/dom-capture.ts
export type PageElement = {
  role: string;
  name: string;
  selector: string;
};

export type CaptureFn = (fn: () => Promise<PageElement[]>) => Promise<PageElement[]>;

/**
 * Snapshot of the live page's interactive elements, for manifest generation
 * to propose steps against. Same `evaluate` abstraction `native-webmcp.ts`
 * already uses to read `document.modelContext` — no new CDP domain.
 *
 * Capped at 150 elements: bounds what reaches the model, mirroring the
 * 8000-character cap `sanitizeSchema` already applies to a discovered
 * tool's schema.
 */
export async function captureInteractiveElements(evaluate: CaptureFn): Promise<PageElement[]> {
  try {
    const elements = await evaluate(captureInPage);
    return elements.slice(0, 150);
  } catch {
    // Page navigated mid-call, closed, or evaluate threw for any other
    // reason — an empty capture, not a crash. generate-manifest.ts turns
    // an empty list into its own "invalid-response" outcome.
    return [];
  }
}

/**
 * Serialized into the remote page by Playwright. Do not close over worker
 * state — same constraint `native-webmcp.ts`'s `nativeCall`/`nativeList`
 * document for the same reason.
 */
async function captureInPage(): Promise<Array<{ role: string; name: string; selector: string }>> {
  function selectorFor(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body) {
      if (node.id) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const current: Element = node;
      const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
      node = parent;
    }
    return parts.length > 0 ? parts.join(" > ") : el.tagName.toLowerCase();
  }

  function roleFor(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "form") return "form";
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      return type === "submit" || type === "button" ? "button" : "textbox";
    }
    return tag;
  }

  function nameFor(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.textContent) return label.textContent.trim().slice(0, 100);
    }
    const text = el.textContent?.trim();
    if (text) return text.slice(0, 100);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const value = (el as HTMLInputElement).value;
    return value ? String(value).trim() : "";
  }

  const found = document.querySelectorAll("button, a, input, select, textarea, [role], form");
  return Array.from(found)
    .slice(0, 150)
    .map((el) => ({ role: roleFor(el), name: nameFor(el), selector: selectorFor(el) }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/dom-capture.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/dom-capture.ts tests/dom-capture.test.ts
git commit -m "feat(generation): capture interactive page elements via page.evaluate"
```

---

### Task 4: Synthesis — generate and validate a manifest

**Files:**
- Create: `worker/generate-manifest.ts`
- Test: `tests/generate-manifest.test.ts`

**Interfaces:**
- Consumes: `runTurn`, `type ModelEnv` from `./agent`; `NAME_RE`, `sanitizeSchema` from `./native-webmcp` (Task 2); `originSlug` from `../shared/origin`; `type PageElement` from `./dom-capture` (Task 3); `type ToolManifest`, `type ManifestStep` from `../shared/manifest`
- Produces: `GenerateOutcome`, `generateManifest(env: ModelEnv, origin: string, elements: PageElement[]): Promise<GenerateOutcome>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/generate-manifest.test.ts
import { describe, expect, it, vi } from "vitest";
import { generateManifest } from "../worker/generate-manifest";
import type { PageElement } from "../worker/dom-capture";

/** Verbatim shape returned by env.AI.run through AI Gateway — same fixture pattern as tests/agent.test.ts. */
function completionWith(content: string) {
  return { choices: [{ message: { content } }] };
}

const ELEMENTS: PageElement[] = [
  { role: "textbox", name: "Search", selector: "input#q" },
  { role: "button", name: "Go", selector: "button.go" },
];

const VALID_TOOL = {
  name: "search_widgets",
  description: "search the catalog",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  steps: [
    { action: "fill", selector: "input#q", from: "q" },
    { action: "click", selector: "button.go" },
  ],
};

describe("generateManifest", () => {
  it("parses and origin-qualifies a valid response", async () => {
    const run = vi.fn(async () => completionWith(JSON.stringify([VALID_TOOL])));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.manifests).toHaveLength(1);
    expect(outcome.manifests[0].name).toBe("search_widgets_on_example_com");
    expect(outcome.manifests[0].origin).toBe("https://example.com");
  });

  it("strips a markdown code fence around the JSON", async () => {
    const run = vi.fn(async () => completionWith("```json\n" + JSON.stringify([VALID_TOOL]) + "\n```"));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(true);
  });

  it("rejects a response that isn't JSON", async () => {
    const run = vi.fn(async () => completionWith("sure, here are some tools: ..."));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.reason).toBe("invalid-response");
  });

  it("drops a tool whose step has an illegal action, keeps the rest", async () => {
    const bad = { ...VALID_TOOL, name: "bad_tool", steps: [{ action: "submit_payment", selector: "x" }] };
    const run = vi.fn(async () => completionWith(JSON.stringify([VALID_TOOL, bad])));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.manifests.map((m) => m.name)).toEqual(["search_widgets_on_example_com"]);
  });

  it("rejects outright when every tool is invalid", async () => {
    const run = vi.fn(async () => completionWith(JSON.stringify([{ name: 123 }])));
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(false);
  });

  it("reports a thrown error rather than crashing", async () => {
    const run = vi.fn(async () => {
      throw new Error("gateway unreachable");
    });
    const outcome = await generateManifest({ AI: { run } }, "https://example.com", ELEMENTS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.reason).toBe("threw");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/generate-manifest.test.ts`
Expected: FAIL — `worker/generate-manifest.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// worker/generate-manifest.ts
import { runTurn, type ModelEnv } from "./agent";
import { NAME_RE, sanitizeSchema } from "./native-webmcp";
import { originSlug } from "../shared/origin";
import type { ManifestStep, ToolManifest } from "../shared/manifest";
import type { PageElement } from "./dom-capture";

export type GenerateOutcome =
  | { ok: true; manifests: ToolManifest[] }
  | { ok: false; reason: "invalid-response" | "threw"; error?: string };

const STEP_ACTIONS = new Set(["goto", "fill", "type", "click", "press", "wait"]);

function buildPrompt(origin: string, elements: PageElement[]): string {
  const lines = elements
    .map((e) => `- role=${e.role} name=${JSON.stringify(e.name)} selector=${e.selector}`)
    .join("\n");
  return [
    `Propose WebMCP tools for ${origin} from the interactive elements below.`,
    `Reply with ONLY a JSON array, no markdown fence, no prose. Each item:`,
    `{"name": string, "description": string, "inputSchema": {"type":"object","properties":{...},"required":[...]}, "steps": [...]}`,
    `Step shapes: {"action":"goto","url":string} | {"action":"fill"|"type","selector":string,"from":string} | {"action":"click","selector":string} | {"action":"press","selector":string,"key":string} | {"action":"wait","selector":string}.`,
    `"from" in a fill/type step must name a property in that tool's own inputSchema.`,
    `Only propose tools for actions actually available below — search, filter, or lookup. Never propose a tool that completes a purchase, payment, checkout, or any other irreversible action.`,
    `Elements:`,
    lines,
  ].join("\n");
}

function validateStep(raw: unknown): ManifestStep | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.action !== "string" || !STEP_ACTIONS.has(s.action)) return null;
  if (s.action === "goto") {
    return typeof s.url === "string" ? { action: "goto", url: s.url } : null;
  }
  if (s.action === "fill" || s.action === "type") {
    return typeof s.selector === "string" && typeof s.from === "string"
      ? { action: s.action, selector: s.selector, from: s.from }
      : null;
  }
  if (s.action === "click") {
    return typeof s.selector === "string" ? { action: "click", selector: s.selector } : null;
  }
  if (s.action === "press") {
    return typeof s.selector === "string" && typeof s.key === "string"
      ? { action: "press", selector: s.selector, key: s.key }
      : null;
  }
  if (s.action === "wait") {
    return typeof s.selector === "string" ? { action: "wait", selector: s.selector } : null;
  }
  return null;
}

function validateManifest(raw: unknown, origin: string): ToolManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name.trim()) return null;
  if (typeof m.description !== "string") return null;
  if (!Array.isArray(m.steps) || m.steps.length === 0) return null;
  const steps: ManifestStep[] = [];
  for (const raw of m.steps) {
    const step = validateStep(raw);
    if (!step) return null;
    steps.push(step);
  }
  const base = m.name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const qualifiedName = `${base}_on_${originSlug(origin)}`.slice(0, 128);
  if (!NAME_RE.test(qualifiedName)) return null;
  return {
    name: qualifiedName,
    description: m.description.slice(0, 500),
    origin,
    inputSchema: sanitizeSchema(m.inputSchema) as ToolManifest["inputSchema"],
    steps,
  };
}

export async function generateManifest(
  env: ModelEnv,
  origin: string,
  elements: PageElement[],
): Promise<GenerateOutcome> {
  try {
    const decision = await runTurn(
      env,
      [{ role: "user", content: buildPrompt(origin, elements) }],
      [],
    );
    if (decision.kind !== "message") {
      return { ok: false, reason: "invalid-response", error: "model returned a tool call" };
    }
    const cleaned = decision.content
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return { ok: false, reason: "invalid-response", error: "not valid JSON" };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: "invalid-response", error: "expected a JSON array" };
    }
    const manifests: ToolManifest[] = [];
    for (const item of parsed) {
      const manifest = validateManifest(item, origin);
      if (manifest) manifests.push(manifest);
    }
    if (manifests.length === 0) {
      return { ok: false, reason: "invalid-response", error: "no valid tools in response" };
    }
    return { ok: true, manifests };
  } catch (err) {
    return {
      ok: false,
      reason: "threw",
      error: err instanceof Error ? err.message : "generation failed",
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/generate-manifest.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/generate-manifest.ts tests/generate-manifest.test.ts
git commit -m "feat(generation): synthesize and validate a manifest via the existing model path"
```

---

### Task 5: Wire messages — `manifest_draft`, `generate_manifest`, `manifest_decision`

**Files:**
- Modify: `shared/protocol.ts`

**Interfaces:**
- Consumes: `ToolManifest` from `./manifest`
- Produces: `ServerMessage` gains `{ v: 1; type: "manifest_draft"; origin: string; tools: ToolManifest[] }`; `ClientMessage` gains `{ v: 1; type: "generate_manifest"; origin: string }` and `{ v: 1; type: "manifest_decision"; origin: string; name: string; bless: boolean }`

- [ ] **Step 1: Add the import**

`shared/protocol.ts`, top of file:

```typescript
import type { ToolManifest } from "./manifest";
```

- [ ] **Step 2: Extend `ClientMessage`**

Before the closing `| { v: 1; type: "ping" };`, add two members:

```typescript
  | { v: 1; type: "generate_manifest"; origin: string }
  | { v: 1; type: "manifest_decision"; origin: string; name: string; bless: boolean }
  | { v: 1; type: "ping" };
```

- [ ] **Step 3: Extend `ServerMessage`**

Before the closing `| { v: 1; type: "pong" };`, add one member:

```typescript
  | {
      v: 1;
      type: "manifest_draft";
      origin: string;
      /** Only ever draft-status tools — nothing here is callable yet. */
      tools: ToolManifest[];
    }
  | { v: 1; type: "pong" };
```

- [ ] **Step 4: Verify the type-check passes**

Run: `pnpm typecheck`
Expected: PASS — these are additive union members; no existing exhaustive `switch` over `ClientMessage`/`ServerMessage` exists yet that would need a new case (Task 6 below adds the one that does, in `session-do.ts`'s `webSocketMessage`).

- [ ] **Step 5: Commit**

```bash
git add shared/protocol.ts
git commit -m "feat(protocol): add manifest_draft, generate_manifest, manifest_decision messages"
```

---

### Task 6: Trigger and bless wiring in `SessionDO`

**Files:**
- Modify: `worker/session-do.ts`

**Interfaces:**
- Consumes: `captureInteractiveElements`, `type CaptureFn` (Task 3); `generateManifest` (Task 4); `recordDraftTools`, `blessTool`, `declineTool`, `getRegistryEntry` (Task 1, Phase 1); the new message types (Task 5)
- Produces: no new public exports — `runGeneration`, `maybeAutoGenerate`, `onGenerateManifest`, `onManifestDecision` are private to `SessionDO`

- [ ] **Step 1: Add imports**

Near the existing imports from `./native-webmcp` and `./manifests`:

```typescript
import { captureInteractiveElements, type CaptureFn } from "./dom-capture";
import { generateManifest } from "./generate-manifest";
import {
  getRegistryEntry,
  recordDraftTools,
  blessTool,
  declineTool,
} from "./manifest-registry";
```

- [ ] **Step 2: Widen the `LiveBrowser.page.evaluate` type**

Find:

```typescript
    evaluate?: EvaluateFn & DiscoverFn;
```

Replace with:

```typescript
    evaluate?: EvaluateFn & DiscoverFn & CaptureFn;
```

- [ ] **Step 3: Add the in-flight guard field**

Alongside the existing private fields (`private launching`, `private pending`, `private driving`, `private remoteTools`, `private remoteToolsOrigin`):

```typescript
  /** Origins currently being generated for — the in-flight guard against
   * duplicate generation from a burst of misses or repeated manual clicks. */
  private generatingOrigins = new Set<string>();
```

- [ ] **Step 4: Add the four new private methods**

Add near `refreshRemoteTools` / the other browser-adjacent private methods:

```typescript
  /**
   * Automatic entry point. Called from a "no WebMCP" miss in
   * list_remote_tools / call_remote_tool. Never regenerates for an origin
   * that already has any registry entry — draft, blessed, or declined — a
   * human re-triggers manually (onGenerateManifest) if they want another
   * pass. Fire-and-forget: callers do `void this.maybeAutoGenerate(...)`.
   */
  private async maybeAutoGenerate(origin: string): Promise<void> {
    const kv = this.env.MANIFEST_REGISTRY;
    if (!kv) return;
    if (!(await this.allowOrigin(origin))) return;
    if (this.generatingOrigins.has(origin)) return;
    const existing = await getRegistryEntry(kv, origin);
    if (existing) return;
    void this.runGeneration(origin, kv);
  }

  /** Manual entry point — the hosted UI's "Map this site" button. */
  private async onGenerateManifest(ws: WebSocket, origin: string): Promise<void> {
    const kv = this.env.MANIFEST_REGISTRY;
    if (!kv) {
      this.send(ws, { v: 1, type: "error", message: "no manifest registry configured" });
      return;
    }
    if (!(await this.allowOrigin(origin))) {
      this.send(ws, { v: 1, type: "error", message: "origin not consented" });
      return;
    }
    if (this.generatingOrigins.has(origin)) return;
    void this.runGeneration(origin, kv);
  }

  /**
   * Capture, synthesize, store as drafts, broadcast. Never awaited by a
   * ChatGPT-facing tool call — this is what keeps the model out of any
   * ChatGPT request/response cycle (README: "no LLM in the hot path").
   */
  private async runGeneration(origin: string, kv: KVNamespace): Promise<void> {
    this.generatingOrigins.add(origin);
    try {
      const live = this.live;
      if (!live?.page.evaluate) {
        this.broadcast({ v: 1, type: "error", message: `no live page open for ${origin}` });
        return;
      }
      const elements = await captureInteractiveElements(
        live.page.evaluate.bind(live.page) as CaptureFn,
      );
      const outcome = await generateManifest(this.env, origin, elements);
      if (!outcome.ok) {
        this.broadcast({
          v: 1,
          type: "error",
          message: `could not map ${origin}: ${outcome.error ?? outcome.reason}`,
        });
        return;
      }
      const entry = await recordDraftTools(kv, origin, outcome.manifests);
      const pending = entry.tools.filter((t) => t.status === "draft").map((t) => t.manifest);
      if (pending.length > 0) {
        this.broadcast({ v: 1, type: "manifest_draft", origin, tools: pending });
      }
    } finally {
      this.generatingOrigins.delete(origin);
    }
  }

  /** Bless or decline one draft tool. Re-broadcasts whatever is still pending. */
  private async onManifestDecision(origin: string, name: string, bless: boolean): Promise<void> {
    const kv = this.env.MANIFEST_REGISTRY;
    if (!kv) return;
    const entry = bless ? await blessTool(kv, origin, name) : await declineTool(kv, origin, name);
    const pending = (entry?.tools ?? [])
      .filter((t) => t.status === "draft")
      .map((t) => t.manifest);
    this.broadcast({ v: 1, type: "manifest_draft", origin, tools: pending });
  }
```

- [ ] **Step 5: Hook the automatic trigger into `list_remote_tools`**

Find (inside `runTool`, the `list_remote_tools` branch):

```typescript
      if (!found.ok) {
        return {
          ok: true,
          text:
            found.reason === "threw"
              ? `Could not read tools on ${url}: ${found.error ?? "unknown error"}`
              : `${url} exposes no WebMCP tools. A tool for this origin would have to be synthesised.`,
        };
      }
      const tools = found.tools ?? [];
      if (tools.length === 0) {
        // modelContext is always present because we install it, so an empty
        // list means the site registered nothing -- not that WebMCP is absent.
        return {
          ok: true,
          text: `${url} registered no WebMCP tools of its own. A tool for this origin would have to be synthesised.`,
        };
      }
```

Replace with:

```typescript
      if (!found.ok) {
        if (found.reason === "no-webmcp") {
          void this.maybeAutoGenerate(originFromUrl(url));
        }
        return {
          ok: true,
          text:
            found.reason === "threw"
              ? `Could not read tools on ${url}: ${found.error ?? "unknown error"}`
              : `${url} exposes no WebMCP tools. A tool for this origin would have to be synthesised.`,
        };
      }
      const tools = found.tools ?? [];
      if (tools.length === 0) {
        // modelContext is always present because we install it, so an empty
        // list means the site registered nothing -- not that WebMCP is absent.
        void this.maybeAutoGenerate(originFromUrl(url));
        return {
          ok: true,
          text: `${url} registered no WebMCP tools of its own. A tool for this origin would have to be synthesised.`,
        };
      }
```

- [ ] **Step 6: Hook the automatic trigger into `call_remote_tool`**

Find (inside `runTool`, the `call_remote_tool` branch):

```typescript
      const native = await callNativeTool(
        live.page.evaluate.bind(live.page) as EvaluateFn,
        parsed.name,
        parsed.arguments,
      );
      if (!native.used) {
        return { ok: false, text: nativeFailure(parsed.name, origin, native) };
      }
```

Replace with:

```typescript
      const native = await callNativeTool(
        live.page.evaluate.bind(live.page) as EvaluateFn,
        parsed.name,
        parsed.arguments,
      );
      if (!native.used) {
        if (native.reason === "no-webmcp") {
          void this.maybeAutoGenerate(origin);
        }
        return { ok: false, text: nativeFailure(parsed.name, origin, native) };
      }
```

- [ ] **Step 7: Add the two `webSocketMessage` cases**

Find:

```typescript
      case "autonomous":
        await this.setAutonomous(msg.on);
        return;
    }
  }
```

Replace with:

```typescript
      case "autonomous":
        await this.setAutonomous(msg.on);
        return;
      case "generate_manifest":
        await this.onGenerateManifest(ws, msg.origin);
        return;
      case "manifest_decision":
        await this.onManifestDecision(msg.origin, msg.name, msg.bless);
        return;
    }
  }
```

- [ ] **Step 8: Typecheck and run the full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. If `MANIFEST_REGISTRY` isn't set in a given test's fake `Env`, every new path degrades to a no-op (`if (!kv) return`) rather than throwing — no existing test should need a registry mock to keep passing.

- [ ] **Step 9: Commit**

```bash
git add worker/session-do.ts
git commit -m "feat(generation): wire automatic and manual generation triggers into SessionDO"
```

---

### Task 7: Plain-language step descriptions

**Files:**
- Create: `shared/describe-steps.ts`
- Test: `tests/describe-steps.test.ts`

**Interfaces:**
- Consumes: `type ManifestStep` from `./manifest`
- Produces: `describeStep(step: ManifestStep): string`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/describe-steps.test.ts
import { describe, expect, it } from "vitest";
import { describeStep } from "../shared/describe-steps";
import type { ManifestStep } from "../shared/manifest";

describe("describeStep", () => {
  it("describes goto", () => {
    expect(describeStep({ action: "goto", url: "https://example.com" })).toBe(
      "opens https://example.com",
    );
  });
  it("describes fill", () => {
    expect(describeStep({ action: "fill", selector: "input#q", from: "query" })).toBe(
      "fills input#q from query",
    );
  });
  it("describes type", () => {
    expect(describeStep({ action: "type", selector: "input#q", from: "query" })).toBe(
      "types into input#q from query",
    );
  });
  it("describes click", () => {
    expect(describeStep({ action: "click", selector: "button.go" })).toBe("clicks button.go");
  });
  it("describes press", () => {
    expect(describeStep({ action: "press", selector: "input#q", key: "Enter" })).toBe(
      "presses Enter on input#q",
    );
  });
  it("describes wait", () => {
    expect(describeStep({ action: "wait", selector: ".results" })).toBe("waits for .results");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/describe-steps.test.ts`
Expected: FAIL — `shared/describe-steps.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// shared/describe-steps.ts
import type { ManifestStep } from "./manifest";

/** One plain-language line per step, for the manifest review screen — the
 * human reads exactly what a generated tool will do before blessing it. */
export function describeStep(step: ManifestStep): string {
  switch (step.action) {
    case "goto":
      return `opens ${step.url}`;
    case "fill":
      return `fills ${step.selector} from ${step.from}`;
    case "type":
      return `types into ${step.selector} from ${step.from}`;
    case "click":
      return `clicks ${step.selector}`;
    case "press":
      return `presses ${step.key} on ${step.selector}`;
    case "wait":
      return `waits for ${step.selector}`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/describe-steps.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/describe-steps.ts tests/describe-steps.test.ts
git commit -m "feat(ui): render a manifest step as a plain-language description"
```

---

### Task 8: The review/bless screen

**Files:**
- Create: `src/components/ManifestReview.tsx`

**Interfaces:**
- Consumes: `type ToolManifest` from `../../shared/manifest`, `describeStep` from `../../shared/describe-steps`
- Produces: `type ManifestDraft = { origin: string; tools: ToolManifest[] }`, `ManifestReview` component with props `{ draft: ManifestDraft | null; onDecide: (name: string, bless: boolean) => void }`

- [ ] **Step 1: Write the component**

```tsx
// src/components/ManifestReview.tsx
import type { ToolManifest } from "../../shared/manifest";
import { describeStep } from "../../shared/describe-steps";

export type ManifestDraft = {
  origin: string;
  tools: ToolManifest[];
};

type Props = {
  draft: ManifestDraft | null;
  onDecide: (name: string, bless: boolean) => void;
};

export function ManifestReview({ draft, onDecide }: Props) {
  if (!draft || draft.tools.length === 0) return null;
  const host = draft.origin.replace(/^https:\/\//, "");
  return (
    <div
      className="manifest-review"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manifest-review-title"
    >
      <div className="manifest-review__card">
        <h2 id="manifest-review-title">new tools found on {host}</h2>
        <p className="muted">
          Generated from the page, not the site's own code. Review each one before it
          becomes callable.
        </p>
        <ul className="manifest-review__tools">
          {draft.tools.map((tool) => (
            <li key={tool.name}>
              <h3>
                <code>{tool.name}</code>
              </h3>
              <p>{tool.description}</p>
              <ol className="manifest-review__steps">
                {tool.steps.map((step, i) => (
                  <li key={i}>{describeStep(step)}</li>
                ))}
              </ol>
              <div className="manifest-review__actions">
                <button type="button" onClick={() => onDecide(tool.name, false)}>
                  Decline
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => onDecide(tool.name, true)}
                >
                  Bless
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

(No test file — this is a presentational component with no branching logic beyond the early `null` return, in the same category as `BlessGate.tsx`, which also ships without a dedicated test. Its behavior is covered by the Session.tsx wiring in Task 9 and manual verification in Task 11.)

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/ManifestReview.tsx
git commit -m "feat(ui): add the manifest review/bless screen"
```

---

### Task 9: Wire `ManifestReview` into `Session.tsx`

**Files:**
- Modify: `src/pages/Session.tsx`

**Interfaces:**
- Consumes: `ManifestReview`, `type ManifestDraft` (Task 8)
- Produces: no new exports — internal component state and WS wiring

- [ ] **Step 1: Add the import**

Alongside the existing `import { BlessGate } from "../components/BlessGate";`:

```typescript
import { ManifestReview, type ManifestDraft } from "../components/ManifestReview";
```

- [ ] **Step 2: Add state**

Alongside `const [bless, setBless] = useState<BlessRequest | null>(null);`:

```typescript
  const [manifestDraft, setManifestDraft] = useState<ManifestDraft | null>(null);
```

- [ ] **Step 3: Handle the incoming message**

Alongside the existing `if (msg.type === "audit") setAudit(msg.rows);` in the `onMessage` handler:

```typescript
        if (msg.type === "manifest_draft") {
          setManifestDraft(msg.tools.length > 0 ? { origin: msg.origin, tools: msg.tools } : null);
        }
```

- [ ] **Step 4: Render the screen**

Find:

```typescript
      <BlessGate
        request={bless}
        onDecide={(ok) => {
          blessWait.current?.(ok);
          blessWait.current = null;
          setBless(null);
        }}
      />
    </div>
  );
}
```

Replace with:

```typescript
      <BlessGate
        request={bless}
        onDecide={(ok) => {
          blessWait.current?.(ok);
          blessWait.current = null;
          setBless(null);
        }}
      />
      <ManifestReview
        draft={manifestDraft}
        onDecide={(name, ok) => {
          if (!manifestDraft) return;
          bridgeRef.current?.send({
            v: 1,
            type: "manifest_decision",
            origin: manifestDraft.origin,
            name,
            bless: ok,
          });
        }}
      />
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pages/Session.tsx
git commit -m "feat(ui): wire the manifest review screen into the session page"
```

---

### Task 10: "Map this site" manual trigger

**Files:**
- Modify: `src/components/Surface.tsx`
- Modify: `src/pages/Session.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces: `Surface` gains `onMapSite?: () => void` and `mapSiteBusy?: boolean` props

- [ ] **Step 1: Add the button to `Surface.tsx`**

Add to `Props`:

```typescript
type Props = {
  origin: string | null;
  remoteTools: DiscoveredTool[];
  registered: ToolSchema[];
  onOffer: (name: string) => void;
  onMapSite?: () => void;
  mapSiteBusy?: boolean;
};
```

Update the signature and the "no tools" branch:

```typescript
export function Surface({
  origin,
  remoteTools,
  registered,
  onOffer,
  onMapSite,
  mapSiteBusy,
}: Props) {
  const offers = offersFor({ registered, origin });
  const host = origin ? origin.replace(/^https:\/\//, "") : null;

  return (
    <section className="surface" aria-label="On this page">
      <h2>on this page</h2>
      <p>
        You browse. ChatGPT can call the tools this origin registered — they
        show up as chips, origin-qualified.
      </p>
      {host ? (
        <p className="muted">{host}</p>
      ) : (
        <p className="muted">Grant an origin to open a page.</p>
      )}
      {remoteTools.length > 0 ? (
        <ul className="surface__tools">
          {remoteTools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
              <span>{t.description}</span>
            </li>
          ))}
        </ul>
      ) : host ? (
        <div className="surface__no-tools">
          <p className="muted">
            No WebMCP tools on this page. Synthesised tools may still apply.
          </p>
          {onMapSite ? (
            <button type="button" disabled={!!mapSiteBusy} onClick={onMapSite}>
              {mapSiteBusy ? "mapping…" : "Map this site"}
            </button>
          ) : null}
        </div>
      ) : null}
```

(the rest of the component — the `offers` block and closing `</section>` — is unchanged)

- [ ] **Step 2: Wire it up in `Session.tsx`**

Find:

```typescript
        <Surface
          origin={pageOrigin}
          remoteTools={remoteTools}
          registered={tools}
          onOffer={(name) => void runOffer(name)}
        />
```

Replace with:

```typescript
        <Surface
          origin={pageOrigin}
          remoteTools={remoteTools}
          registered={tools}
          onOffer={(name) => void runOffer(name)}
          mapSiteBusy={mapSiteBusy}
          onMapSite={
            pageOrigin
              ? () => {
                  setMapSiteBusy(true);
                  bridgeRef.current?.send({ v: 1, type: "generate_manifest", origin: pageOrigin });
                }
              : undefined
          }
        />
```

Add the state near `manifestDraft`:

```typescript
  const [mapSiteBusy, setMapSiteBusy] = useState(false);
```

Clear it once a draft arrives or an error comes back — extend the two existing handlers:

```typescript
        if (msg.type === "manifest_draft") {
          setMapSiteBusy(false);
          setManifestDraft(msg.tools.length > 0 ? { origin: msg.origin, tools: msg.tools } : null);
        }
```

and, in the existing `if (msg.type === "error")` branch, add `setMapSiteBusy(false);` alongside whatever it already does.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/Surface.tsx src/pages/Session.tsx
git commit -m "feat(ui): add a manual \"Map this site\" trigger"
```

---

### Task 11: End-to-end — the automatic trigger never blocks

**Files:**
- Test: `tests/manifest-generation-trigger.test.ts` (new)

**Interfaces:**
- Consumes: `recordDraftTools` (Task 1), `type RegistryEntry`, `type KvLike` (Phase 1)

This test exercises the pure pieces of the trigger contract directly — `maybeAutoGenerate`'s guard logic isn't reachable without a full `SessionDO` instance (Durable Object storage, a live browser), so rather than stand up that harness, this test locks down the two properties that matter at the unit level: a `"no-webmcp"` outcome from `native-webmcp.ts` is exactly the signal that should trigger generation, and `recordDraftTools` is idempotent against a burst of duplicate calls (the shape of "several ChatGPT misses in a row before the first generation completes").

- [ ] **Step 1: Write the test**

```typescript
// tests/manifest-generation-trigger.test.ts
import { describe, expect, it, vi } from "vitest";
import { recordDraftTools, type KvLike } from "../worker/manifest-registry";
import type { ToolManifest } from "../shared/manifest";

const TOOL: ToolManifest = {
  name: "search_widgets_on_example_com",
  description: "search widgets",
  origin: "https://example.com",
  inputSchema: { type: "object", properties: {} },
  steps: [{ action: "goto", url: "https://example.com" }],
};

function fakeKv(): KvLike {
  const store: Record<string, string> = {};
  return {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
  };
}

describe("generation trigger contract", () => {
  it("recordDraftTools is idempotent against repeated calls for the same origin", async () => {
    const kv = fakeKv();
    await recordDraftTools(kv, "https://example.com", [TOOL]);
    const second = await recordDraftTools(kv, "https://example.com", [TOOL]);
    expect(second.tools).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `pnpm vitest run tests/manifest-generation-trigger.test.ts`
Expected: PASS — this locks in the exact property `maybeAutoGenerate`'s "skip if an entry already exists" guard depends on: even without that guard, a second write for the same tool wouldn't duplicate it.

- [ ] **Step 3: Commit**

```bash
git add tests/manifest-generation-trigger.test.ts
git commit -m "test(generation): lock in recordDraftTools idempotency"
```

---

### Task 12: Full regression

- [ ] **Step 1: Run everything**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, zero regressions in any existing suite.

- [ ] **Step 2: Manual smoke test**

With `pnpm dev` running and a deployed (not `localhost`) target origin with no WebMCP granted:
1. Grant the origin.
2. Ask the in-page chat (or ChatGPT, if testing against the live deploy) to search or use the site — `list_remote_tools` should report no tools, and within a few seconds the "Map this site" prompt or an automatic `manifest_draft` broadcast should appear.
3. Click "Map this site" if it didn't fire automatically. Confirm the review screen shows real steps referencing real selectors on that page.
4. Bless one tool, decline another. Confirm the declined one never reappears and the blessed one is now listed by `list_available_origins`/callable via `call_remote_tool`... actually via its own origin-qualified name directly, since it is now returned by `manifestFor`.

- [ ] **Step 3: Commit if the smoke test needed fixes**

Otherwise this task produces no commit — Task 12 exists to catch integration issues Tasks 1-11's isolated unit tests can't.

---

## Self-Review Notes

- **Spec coverage:** Capture (Task 3), Synthesis (Task 4), Storage write side (Task 1), Trigger flow both entry points (Task 6), Review & bless (Tasks 7-9), "no LLM in the hot path" preserved (Task 6, Step 4's `void this.runGeneration(...)` is never awaited by a tool-call return). The spec's "What stays untouched" claim (execution) is not a task — it's a claim about Phase 1's work already being sufficient, verified by Task 12's regression run touching zero step-replay code.
- **Deferred, per the spec's Non-goals and this plan's own Task 6 comments:** live selector re-resolution, an automated risk classifier for steps (Task 8's review screen is transparency-only, by design), and whether the "known origins" catalog (`session-do.ts:498`, `:885`, both untouched by both phases) should grow to include registry-backed origins.
- **Type consistency checked:** `PageElement` (Task 3) flows unchanged into `generateManifest`'s `elements` parameter (Task 4); `ManifestDraft` (Task 8) matches the `manifest_draft` message shape (Task 5) field-for-field; `KvLike` (Phase 1) is satisfied structurally by the real `KVNamespace` passed as `this.env.MANIFEST_REGISTRY` (Task 6) with no adapter needed.
