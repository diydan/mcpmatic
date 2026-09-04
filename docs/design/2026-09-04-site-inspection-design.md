# Site inspection — design

**Status:** proposed. No code written. Anchored to `e5d44d1`.

Prerequisite for `2026-09-04-generated-tools-design.md`, and useful without
it. That document generates tools; this one only looks.

## Goal

Make this sentence true, all of it:

> Add WebMCP to any site instantly. No install, no extension — simply enter a
> web address, we analyse the site, and open it in a browser with WebMCP
> applied in real time.

Every clause already holds except **"we analyse the site."** The API injection
ships (`session-do.ts`, `addInitScript` before the page's own scripts), there
is nothing to install, and typing an address is the whole flow.

What does not hold is the analysis. For a site that publishes WebMCP we report
its tools. For a site that publishes none — most of the web — the report is a
dead end:

> `<url> registered no WebMCP tools of its own. A tool for this origin would
> have to be synthesised.`

True, and useless. It names what is absent and nothing about what is there.

## Outcome

Type any address and get a real answer within seconds:

- **A site with WebMCP** — its tools, as now.
- **A site without** — what it *does* expose. "No WebMCP. Found a search form
  (`GET /search`, field `q`), a JSON-LD SearchAction, 3 other forms, 41
  interactive controls." Enough for a person to see whether a tool is possible,
  and enough for the generator to build one later.
- Either way the console shows it, and an agent can ask for it by tool.

The demo consequence: a judge types **their own** site and gets a specific,
recognisable description of it back. No hardcoded catalog, no model, no
waiting.

## Non-goals

- **No generation.** This produces a report, never a `ToolManifest`.
- **No execution.** Nothing is clicked, filled or submitted. Read-only, so it
  is safe to run on any granted origin without asking.
- **No model.** Everything here is a deterministic read. A model that
  hallucinates a form field would poison the generator that reads this later.
- **No new browser.** Inspection runs on the page already open, like
  `list_remote_tools`. It never launches Chromium on its own.

## Design

### One capture pass

`worker/inspect-site.ts`, `inspectPage(evaluate: EvaluateFn):
Promise<PageInspection>` — the same `EvaluateFn` `native-webmcp.ts` already
exports, wired the same way (`live.page.evaluate.bind(live.page)`). Serialized
into the page, closing over nothing, exactly as `nativeCall` documents.

It reads, in this order, because the earlier sources are declarations and the
later ones are inference:

1. **JSON-LD** `SearchAction` with a `urlTemplate` — a site publishing this has
   told machines how to search it. Highest confidence, no guessing.
2. **`<form>` elements** — `action`, `method`, and each named input's `name`,
   `type` and `required`. A form is already a tool schema; reading one is
   arithmetic, not judgement.
3. **Search affordances** — `input[type=search]`, `role="searchbox"`,
   `[name=q|s|query|search]`, for sites whose search is not in a form.
4. **A count of interactive controls** — buttons, links, inputs, `[role]`. A
   number, not a list: it tells a reader whether the page is rich or empty
   without dumping the DOM into a tool result.

Bounded: at most 20 forms, 30 fields per form, and the whole result capped the
way `sanitizeSchema` caps schemas at 8000 characters. A page is remote input.

### What it returns

```ts
type PageInspection = {
  url: string;
  webmcp: { present: boolean; polyfilled: boolean; tools: DiscoveredTool[] };
  searchActions: { urlTemplate: string }[];      // from JSON-LD
  forms: {
    action: string;
    method: string;
    fields: { name: string; type: string; required: boolean }[];
  }[];
  searchInputs: { selector: string; name?: string }[];
  interactiveCount: number;
};
```

No selectors beyond what a later generator needs, and no page text. This is a
description of structure, not a copy of the page.

### Where it surfaces

- **A spine tool, `inspect_site`.** Reports on the open page, never launches a
  browser — the same rule `list_remote_tools` follows, and the same honest
  message when nothing is open. The console already calls this "inspecting"
  ("A site you add is inspected for WebMCP"), so the name matches the words
  already on screen.
- **The console.** The "on this page" panel replaces the dead end with the
  report: what the site publishes, and what it exposes if it publishes nothing.

`list_remote_tools` stays as it is. It answers "what WebMCP does this page
have"; `inspect_site` answers "what is on this page at all", and one is a
strict subset of the other's job.

## Why this is worth shipping alone

It makes the claim true, and it is the half that cannot go wrong: read-only,
deterministic, no model, no side effects. If the generator is never built, a
person still types any address and learns something specific about it.

And it is the input the generator needs. Writing it first means the risky half
later consumes a tested, boring artifact rather than reading the DOM itself.

## Testing

Conventions from `tests/native-webmcp.test.ts`, which already mocks
`EvaluateFn` with `vi.fn()`:

- A page with a JSON-LD `SearchAction` yields its `urlTemplate`.
- A plain `<form method=get action=/search>` with `q` yields one form and one
  field, `required` preserved.
- A page with `input[type=search]` outside a form is found.
- A page with none of these yields an empty report and no error — "nothing
  here" is an answer, not a failure.
- The caps hold: 21 forms yield 20; an oversized result is truncated.
- An `evaluate` throw returns an empty inspection rather than escaping, matching
  how `callNativeTool` handles a page that navigated mid-call.
- Live: extend `tests/phases-smoke.sh` to inspect a real origin and assert the
  report names at least one form or search affordance.

## Open questions

- Whether to inspect automatically on navigation, or only when asked.
  Automatic is a better demo and costs a `page.evaluate` per navigation.
- Whether `interactiveCount` should be a count or a small histogram by role.
  A count is honest about being a signal; a histogram invites over-reading.
- Whether the report should say what a tool *would* look like — a sentence like
  "a search tool is possible here" — or stay strictly descriptive and leave
  that judgement to the generator.
