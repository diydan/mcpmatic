# Auto-generated manifests — design

**Status:** proposed, not yet planned or implemented.

## Problem

Two mechanisms make a remote origin callable today. Native WebMCP
(`worker/inject-webmcp.ts`, `worker/native-webmcp.ts`) costs nothing per
site but only works where the site already shipped `document.modelContext`
code — Shopify's Liquid theme, so far. Hand-authored manifests
(`shared/stores.ts`) work on anything, but cost a human writing
`goto`/`fill`/`click`/`press`/`wait` steps per origin, and that's why the
demo has exactly two of them (kayak, gov.uk).

Neither path scales to "grant any origin and get tools." This spec adds a
third: synthesize a manifest from the page itself, gate it behind a human
reading and blessing it once, then run it through the same deterministic
step-replay every hand-authored manifest already uses.

## Non-goals (this phase)

- **No live selector re-resolution.** A generated manifest bakes selectors
  at generation time, same as a hand-authored one. If the site's DOM
  changes, the tool breaks the same way `search_flights_on_kayak_com`
  would. Re-crawl-on-failure is a later phase.
- **No automated risk classification of steps.** The review screen shows
  the human the exact steps; it does not try to guess which ones are
  "safe" or "destructive." See Trust model below.
- **No cross-session manifest editing UI.** A human blesses or doesn't;
  editing a draft's steps by hand is a later phase.
- **No new consent mechanism.** Generation is only offered for an origin
  already granted through the existing consent flow.

## Precondition

Generation is only ever offered for an origin that is already consented
(`consented(origin)` in `worker/session-do.ts`) **and** for which
`discoverNativeTools` has already returned `{ ok: true, tools: [] }` or
`{ ok: false, reason: "no-webmcp" }`. An origin with native WebMCP tools
never reaches this path — those tools are proxied as-is, unchanged.

## Trigger flow

Two entry points feed one pipeline. The distinction that matters is
whether generation can add latency to a ChatGPT turn — it never does,
regardless of which entry point started it.

**Manual.** The hosted UI offers a "Map this site" action once
`list_remote_tools` has reported no native tools for the current origin.
The operator is already watching the live screencast; clicking is a
synchronous wait-then-review from their point of view.

**Automatic.** When `call_remote_tool` or the façade's own
`list_remote_tools` handler misses — no manifest, no native tools — the
DO returns the existing miss outcome to the caller immediately, exactly as
it does today. Separately, it starts generation as a background task on
the DO (not awaited by the request that triggered it). ChatGPT's turn
completes on the existing miss reason; it never waits on an LLM call.

When a background generation finishes, the DO broadcasts a
`manifest_draft` message over the same WebSocket channel `audit` rows
already use (`broadcast()` in `session-do.ts`). The hosted UI surfaces a
"N draft tools found — review?" prompt the next time a human is looking
at the session. Nothing is callable from either entry point until a human
blesses it — see Review & bless below.

This is what "no LLM in the hot path" continues to mean after this
change: not just deterministic execution (already true), but no LLM
invocation inside any ChatGPT request/response cycle, period. The
automatic trigger fires a background task and returns; it does not make a
tool call wait on a model.

## Capture: walk the DOM through the existing `evaluate` path

**Revised from the first draft of this spec**, which proposed a second CDP
domain (`Accessibility.getFullAXTree`). That tree identifies nodes by
`backendDOMNodeId`, which then needs a *separate* correlation step (the
`DOM` domain) to turn back into something with a real CSS selector — a
second CDP surface this codebase doesn't otherwise touch, for a step
generation doesn't strictly need the accessibility semantics of. The
codebase already has a simpler, proven path for reading page structure:
`page.evaluate`, used today by `discoverNativeTools`/`callNativeTool`
(`worker/native-webmcp.ts`) to read `document.modelContext` out of the
remote page. Capture reuses exactly that mechanism instead.

Add `worker/dom-capture.ts`, `captureInteractiveElements(evaluate:
EvaluateFn): Promise<PageElement[]>` — same `EvaluateFn` type
`native-webmcp.ts` already exports, so it's wired into `session-do.ts` the
same way `callNativeTool`/`discoverNativeTools` already are:
`live.page.evaluate.bind(live.page)`. Serialized into the remote page (same
"do not close over worker state" constraint `native-webmcp.ts`'s own
`nativeCall`/`nativeList` document), the in-page function:

- Selects `button, a, input, select, textarea, [role], form`.
- For each: `role` from an explicit `role` attribute, else a tag-based
  default (`button` → "button", `a` → "link", `input[type=submit]` →
  "button", `input` → "textbox", `select` → "combobox", `form` → "form").
- `name` from `aria-label`, else an associated `<label>`'s text, else
  `textContent` (trimmed), else `placeholder`, else `value`.
- `selector`: an nth-child walk up to the nearest ancestor with an `id`
  (or `document.body`) — the same technique Chrome DevTools uses for "Copy
  selector," computed in-page where the real DOM is, not reconstructed
  from an abstracted tree afterward. Good enough for step generation; not
  claimed to be stable across a redeploy of the target site — same caveat
  the first draft carried, now attached to the mechanism that actually
  produces the selector.
- Capped to the first 150 elements, mirroring the 8000-character cap
  `sanitizeSchema` already applies in `native-webmcp.ts` — bounding what
  reaches the model, not just what a tool declares.

## Synthesis: reuse the existing model path

`worker/agent.ts` already defines `ModelEnv` (`env.AI` via AI Gateway,
`openai/gpt-5.5`, `OPENAI_API_KEY` fallback) and the two-path
`modelPath()` selection. Generation reuses that — no new binding, no new
secret.

Add `worker/generate-manifest.ts`, `generateManifest(env: ModelEnv,
origin: string, elements: PageElement[]): Promise<GenerateOutcome>`:

- Prompts the model for `ToolManifest[]` shaped exactly like
  `shared/manifest.ts`'s type — the same `goto`/`fill`/`click`/`press`/`wait`
  vocabulary hand-authored manifests use, `inputSchema` as JSON Schema,
  `fillsFrom` as dotted profile paths. Nothing downstream (execution,
  origin-qualified naming, `sanitizeSchema` conventions from
  `native-webmcp.ts`) needs to know a manifest was generated rather than
  written.
- The response is parsed and validated against that shape before it
  touches storage. A response that doesn't parse, or names a step action
  outside the fixed five, or omits a required field, is rejected outright
  — `GenerateOutcome = { ok: false, reason: "invalid-response" | "threw" }`.
  Reuse `sanitizeSchema`'s length cap and the `NAME_RE` tool-name pattern
  from `worker/native-webmcp.ts` on every generated tool name.
- Origin-qualify every generated tool name the same way `shared/stores.ts`
  does (`_on_<slug>` from `originSlug`). The model is not trusted to get
  this right; the worker enforces it after the fact.

## Storage: one KV namespace, draft/blessed states

New binding `MANIFEST_REGISTRY` (KV), mirroring the existing
`OAUTH_TOKENS` binding rather than a new Durable Object — this data is
read-heavy (checked on every `list_remote_tools`/`call_remote_tool`) and
write-rare (once on generation, once on bless), which is KV's shape, not
a DO's.

**Revised from the first draft**, which put `status` at the entry level
(`{ status: "draft" | "blessed", manifest: ToolManifest[], ... }`) — that
directly contradicted this spec's own Review & bless section below ("Bless
is per-tool, not all-or-nothing for the origin"). Status belongs on each
tool, not on the origin as a whole. Implemented (Phase 1) as two key
shapes over the same data:

```ts
type GeneratedToolStatus = "draft" | "blessed" | "declined";

type GeneratedTool = {
  manifest: ToolManifest;
  status: GeneratedToolStatus;
  generatedAt: number;
  blessedAt?: number;
};

type RegistryEntry = {
  tools: GeneratedTool[];
};
```

`origin:<origin>` holds the full `RegistryEntry` for that origin — every
tool ever generated for it, any status, the source of truth a listing
reads. `tool:<name>` holds a blessed tool's `ToolManifest` directly,
written alongside the per-origin entry when a tool is blessed — the O(1)
path `manifestFor` needs, since it only has a tool name, not an origin, to
look up by. The two keys must be written and deleted together; KV has no
cross-key transactions, so a write that updates one and not the other
produces either a tool that's listed but not callable, or callable but not
listed. Phase 2's bless/decline write path owns keeping them in sync.

`worker/manifests.ts` (`manifestFor`, `originOfTool`) and
`worker/mcp/tools.ts` (`buildToolList`) currently read only the static
`MANIFESTS` array built from `shared/stores.ts` at bundle time. Phase 1
made all three registry-aware as a second source, **blessed entries
only** — a `"draft"` or `"declined"` entry is invisible to them, and
therefore to `list_remote_tools`/`call_remote_tool`/MCP `tools/list`,
exactly as an unconsented origin is invisible today. Every call site that
resolves a tool by name or builds a tool list moved from sync to async,
threading the KV binding through.

## Review & bless

A new screen, not the existing `BlessGate` — `BlessGate` confirms a
*value* leaving the device on a specific call; this confirms a *tool*
should exist at all, once, before it's ever callable. Shown from both
entry points (manual: after the synchronous wait; automatic: from the
"N draft tools found" prompt).

For each draft tool: name, description, and its exact `steps` array
rendered in plain language — "clicks `button.search`, fills `input#origin`
from `origin`" — before the human can bless it. Bless is per-tool, not
all-or-nothing for the origin; declining a tool discards it, it is not
re-offered from the same generation run.

**Trust model for this phase:** transparency substitutes for automated
judgment. The review screen shows exactly what a tool will do; it does
not try to score or flag which steps look like a purchase or a
destructive action. This mirrors the existing profile-field bless flow,
which shows the human the exact value rather than trying to classify
which fields are sensitive. A later phase may add step-pattern flags
(e.g. a click on something that looks like a final submit); this phase
does not, to avoid a classifier whose false negatives are worse than no
classifier.

Blessing writes `status: "blessed"`, `blessedAt: Date.now()` to the KV
entry. There is no per-human identity to record — this system has no
login (`README.md`: "No login, no key, no install") — so unlike the audit
table's `origin`/`tool`/`field_names` rows, a blessed manifest records
*when*, not *who*.

**Constraint carried over from the MCP server phase-1 plan, restated
here because it applies to this feature too:** no changes to the audit
table shape (`{origin, tool, field_names, ts}`, no value column, ever).
Manifest generation and bless events do not write to that table. They
live entirely in the new KV registry and the WebSocket broadcast; the
audit table stays exactly what it is today — a record of profile field
usage, nothing else.

## What stays untouched

Execution. A blessed generated manifest is just another `ToolManifest`
returned by `manifestFor`. The existing step-replay in
`worker/session-do.ts` does not know or care whether a manifest was
written by a human or synthesized — same code path, same determinism, no
model invoked at call time.

## Testing

Same mocking conventions already in `tests/`:

- `worker/dom-capture.ts` — like `tests/native-webmcp.test.ts` mocks
  `EvaluateFn`, mock `evaluate` with `vi.fn()` returning fixture element
  lists; assert the 150-element cap and that an `evaluate` throw (page
  navigated mid-call, closed) returns an empty list rather than throwing
  out of `captureInteractiveElements`.
- `worker/generate-manifest.ts` — like `tests/agent.test.ts`, mock
  `env.AI.run` with `vi.fn()` returning fixture completions: a valid
  manifest (parses, stored as draft), a response with an illegal step
  action (rejected), a response naming a tool with an illegal character
  (rejected, same `NAME_RE` as `native-webmcp.test.ts` already exercises),
  and a thrown/network-failure case.
- `worker/manifests.ts` — `manifestFor`/`originOfTool` against a fake KV
  (`{ get: vi.fn(), put: vi.fn() }`) covering: no entry, `"draft"` entry
  (invisible), `"blessed"` entry (visible, merged with the static list).
- End-to-end: a session-do-level test asserting the automatic trigger's
  request completes on the existing miss reason without awaiting
  generation, and that a background completion produces the
  `manifest_draft` broadcast.

## Open questions for a later phase

- Re-crawl and re-bless when a blessed tool's step fails at call time
  (selector drift) rather than leaving it silently broken.
- Whether a generated tool should ever be allowed to carry `fillsFrom`
  without an explicit second bless step scoped to that specific field
  path, separate from the tool-existence bless this phase adds.
- Sharing a blessed manifest across deployments rather than per-worker
  KV (this phase's registry is scoped to one Worker's KV namespace, same
  as `OAUTH_TOKENS` is today).
