# Generated tools — design

**Status:** proposed. No code written.

**Anchored to `ab76dc1`.** This tree has had three sessions writing to it in one
day; check the references below before planning.

**Supersedes the scope of** `2026-09-03-manifest-generation-design.md`. That
document is still the right architecture. This one narrows it to something
shippable and, more importantly, changes the order: verification comes before
synthesis, because the machinery to verify now exists and it is what makes a
model's output safe to offer a human.

## Goal

Make one sentence true:

> A site that publishes no agent tools can be given one, and you will know it
> works before you are asked to trust it.

Today the catalog is four hand-made entries. Two Shopify storefronts whose
tools we proxy rather than create, and two — Kayak and GOV.UK — whose steps a
human wrote by hand. "Grant any origin and get tools" is the claim the product
makes and does not keep.

## Outcome

Observable, in this order, or the phase has not landed:

1. A human grants an origin with no WebMCP of its own — their own site, chosen
   on the spot — and within seconds the console offers a generated tool.
2. The tool was **run against the live page before being offered**. A tool that
   did nothing is never shown.
3. The offer names what it will do in plain words and shows the evidence it
   worked: the URL it reached, the fields it filled, whether the page reported
   errors.
4. The human approves it once. It becomes callable over `/mcp` and the WebMCP
   façade like any hand-written manifest, with no code path knowing the
   difference.
5. A tool that later stops working says so, rather than reporting success.

The demo consequence, which is the point: a judge types **their own** site and
watches a tool appear. That is a stronger three minutes than four hardcoded
cards, and it cannot be faked.

## Why this is now cheap: what already exists

The expensive halves are built and were verified against the live deployment
today.

- **Injection into any page.** `session-do.ts:1188` calls
  `addInitScript({ content: WEBMCP_POLYFILL })` before the page's own scripts
  run. Every granted origin already gets `document.modelContext`, which is why
  Allbirds registers ten tools in a browser that has no origin trial. Nothing
  about generation needs new injection.
- **Reading a page's surface.** `discoverNativeTools`
  (`native-webmcp.ts:215`) already round-trips through `page.evaluate`.
  Capture reuses that mechanism rather than a second CDP domain.
- **Storage with a draft state.** `manifest-registry.ts` has
  `GeneratedTool { manifest, status: "draft" | "blessed" | "declined" }`,
  `getRegistryEntry` and `blessedManifests`. Its own comment says "nothing
  writes it yet, so it always misses today" — the read half is done, the write
  half is this phase.
- **Human approval.** The console, `ApprovalGate`, the suspend/resume path and
  `check_approval` all exist and were driven end to end in a browser today.
- **And the piece that changes the risk calculus: evidence.** `runSteps`
  returns `StepReport { fillsAttempted, fillsLanded }` (`steps.ts:79`), and
  `PageErrorLog` / `describePageErrors` (`page-errors.ts`) report what the page
  itself complained about.

That last one is the whole argument for doing this now. The danger with a
model-authored tool is not a wrong guess; it is a wrong guess that **reports
success**. That failure mode is already closed — `fill_checkout` on the
Allbirds home page returned *"found none of its fields … nothing was filled"*
rather than "ran". Generation can therefore be gated on evidence rather than on
a human's willingness to read selectors.

## Scope: search first

One interaction, not "any tool".

Search is the right first target because it is the most common thing a site
offers, it is the easiest to verify (the URL changes, results appear, the page
logs no errors), and a generated search tool is immediately useful in the
demo's own narrative — one conversation across several sites.

Anything richer — checkout, booking, multi-step forms — stays hand-written.
The catalog then reads honestly: *sites that publish their tools work fully,
sites that do not get a generated search tool, and anything else is written by
a human.*

## The loop

Capture → synthesise → **verify** → offer → approve → store. Verification sits
before the human, not after, and that ordering is the design.

### 1. Capture

`worker/dom-capture.ts`, `captureSearchCandidates(evaluate: EvaluateFn)`.
Serialized into the page the same way `nativeCall` is, closing over nothing.

Read the machine-readable structure first, because most sites already declare
it and a model is not needed to find it:

- `<form>` elements: `action`, `method`, and named inputs. A form is already a
  tool schema — name, required, type — and reading one is deterministic.
- `input[type=search]`, `role="searchbox"`, `[name=q|s|query|search]`.
- JSON-LD `SearchAction` with its `urlTemplate`, which some sites publish
  precisely so machines can search them.

Selectors are an nth-child walk to the nearest ancestor with an `id`, computed
in-page where the real DOM is. Capped, like `sanitizeSchema`'s 8000-character
cap, so the model sees a bounded surface.

### 2. Synthesise

Only when step 1 found no machine-readable answer. A form or a JSON-LD
`SearchAction` already *is* the tool, and running a model over one would add a
failure mode to a path that has none — so Phase A skips this step entirely and
Phase B fills it in for the pages where capture came back ambiguous.

`worker/generate-manifest.ts`, `generateSearchTool(env, origin, candidates)`,
reusing `agent.ts`'s existing `ModelEnv` — no new binding, no new secret.

The model's job is deliberately small: pick the candidate, name the tool,
describe it, and produce a `ToolManifest` in the existing vocabulary
(`shared/manifest.ts`: `goto | fill | type | click | press | wait`). Everything
structural is enforced afterwards by the worker, not trusted from the model —
origin-qualified naming via `originSlug`, the `NAME_RE` pattern, the step
vocabulary, and `inputSchema` shape. A response that does not parse, or names
an action outside the six, is rejected outright.

Where JSON-LD gave a `urlTemplate`, no model is involved at all: the tool is a
single `goto` with an interpolated query.

### 3. Verify — the load-bearing step

Run the candidate tool against the live page with a probe query, and keep only
what demonstrably worked.

`worker/verify-tool.ts`, `verifyGeneratedTool(...) → VerificationOutcome`:

- Snapshot `page.url()` and clear a fresh `PageErrorLog`.
- Run the manifest through the same `runSteps` the real path uses. Not a
  parallel implementation — a generated tool must be verified by the code that
  will later execute it, or the verification proves nothing.
- Collect: `fillsLanded > 0`, whether the URL changed, whether the page's own
  text changed materially, and `describePageErrors()`.

Rejected if nothing filled, or nothing changed, or the page reported errors
that started during the run. A rejected tool is never offered and never stored
as a draft — a draft nobody can act on is clutter, and the human's attention is
the scarcest input in this system.

**Probe queries are inert.** A search for a nonsense token reads the site and
changes nothing. Generation never runs a step that could write: no tool whose
steps include a `click` on a control the capture stage identified as a submit
outside a search form, and never on a page behind a login.

### 4. Offer

The console shows one card per surviving tool: the plain-language description,
the origin, and the evidence — *"searched for `wool`, reached
`/search?q=wool`, page reported no errors."*

This is deliberately not the approval dialog. That dialog answers "may this
value leave my machine" for one call. This answers "should this tool exist at
all", once. Different question, different screen, and the existing dialog's
single-slot discipline should not be borrowed for it.

### 5. Store

Writes the registry's missing half. `putRegistryEntry` must keep
`origin:<origin>` and `tool:<name>` in sync — the module's own comment warns
that a partial write yields a tool that is listed but not callable, or callable
but not listed. KV has no cross-key transaction, so write `tool:` first and
`origin:` second: a tool nobody lists is invisible, a tool listed but missing
is a broken button.

Blessed entries are already read by `blessedManifests` and merged into
`buildToolList`. Nothing downstream learns that a manifest was generated.

## What stays untouched

The audit table's shape. `isPrivateUrl` on every navigation, including the
verification run. Origin-qualified names. Consent gating listing, not just
execution. The approval path for anything with `fillsFrom` — **a generated tool
never declares `fillsFrom` in this phase**, so it can never move a profile
field. Search needs no personal data, and a model-authored tool asking for a
postcode is a trust question this phase does not need to answer.

## Trust model

Three gates, and the order matters.

1. **Consent.** Generation is only offered for an already-granted origin.
2. **Evidence.** A tool that has not demonstrably worked is never shown.
3. **A human.** Blessing is per tool, once, before it is callable anywhere.

The earlier spec proposed transparency as the substitute for judgement — show
the human the steps. Today's browser work says that is not enough: a person
reading `input[autocomplete='given-name']` cannot tell whether it will match.
Evidence is what a person can actually judge, so the design leans on it and
keeps the step list behind a disclosure.

## Testing

Same conventions as `tests/`:

- **Capture** — mock `evaluate` with fixture DOM shapes: a plain `<form>`, a
  JSON-LD `SearchAction`, a page with no search at all. Assert the cap, and
  that an `evaluate` throw yields an empty list rather than escaping.
- **Synthesis** — mock `env.AI.run` like `agent.test.ts`: a valid manifest, an
  illegal step action, an illegal tool name, a thrown call. Assert the worker
  re-qualifies the name rather than trusting the model's.
- **Verification** — the important tests. A run that fills nothing is rejected.
  A run that fills but changes no URL and no text is rejected. A run that
  triggers page errors is rejected. A run that works is accepted. These use the
  real `runSteps` against a fake `ElementPage`, because verification that does
  not exercise the execution path proves nothing.
- **Registry writes** — both keys written, `tool:` before `origin:`; a failed
  second write leaves no listed-but-uncallable tool.
- **Live** — extend `tests/phases-smoke.sh`: generate against a real origin and
  assert the offered tool carries evidence.

## Phasing

- **A — deterministic only.** Capture plus verification plus the registry write
  path, generating from forms and JSON-LD with **no model at all**. This alone
  makes the goal sentence true for a large share of sites, and it is the half
  that cannot hallucinate.
- **B — model synthesis** for pages where the deterministic read finds nothing,
  behind the same verification gate.
- **C — drift.** A blessed tool that fails at call time is re-verified and, if
  it no longer works, marked stale rather than left quietly broken.

A is the phase worth having. B is a smaller addition than it looks once A's
verification exists, and it is strictly less trustworthy — so it should ship
second and be labelled as generated in the offer.

## Open questions

- Whether a generated tool should be shareable across deployments, or stay
  per-Worker as `OAUTH_TOKENS` and `MANIFEST_REGISTRY` are today. Sharing is
  where the human attention actually compounds, and it needs its own trust
  story.
- What "the page changed materially" means precisely. Text-length delta is
  crude and will misjudge a site that renders results into an unchanged shell.
- Whether verification should run in the human's session, costing them the
  wait, or in a background session, costing a second Chromium against a
  concurrency limit that already bit once today.
