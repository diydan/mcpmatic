# Open-web tasks: unpin the chips, let the agent choose

Date: 2026-09-07
Branch: `prod` (the only branch that moves; `main` and `hackathon-code-freeze`
are frozen at `1d1d850`)

## Problem

The landing page promises the open web and delivers a four-site demo.

`src/pages/Home.tsx:88-108` renders four "Try asking" chips. Each one posts a
hardcoded `origin` alongside its prompt:

| Chip | Pinned origin | Works? |
|---|---|---|
| "Find the best deal across 4 stores" | `allbirds.com` | No — one store, and the catalog holds two actual stores |
| "Book dinner & movie tickets together" | `kayak.com` | No — Kayak does neither |
| "Plan and price my trip in one shot" | `kayak.com` | Yes |
| "Auto-fill council forms & applications" | `gov.uk` | Yes |

Two of four chips send the agent to a site that cannot perform the advertised
task. The pins are the cause: the copy describes what the product does, and
pinning is what makes the copy false.

The deeper problem is what the page teaches. `docs/positioning-and-demo.md`
states the claim as *"Your AI assistant is a customer of the open web"*, and
`worker/session-do.ts:1459` states the intent in code:

> "add WebMCP to any website" is the product, and a fixed catalog is not it.

Yet every affordance on the landing page pins a catalog origin, so a first-time
visitor learns the opposite. The genuinely novel path — type an uncatalogued
site, watch it get inspected and mapped — has no representation on the page.

## What already works

The free-text box already does the right thing. `src/pages/Session.tsx:241`:

```
// If this is a direct site visit (not a general task prompt), open the
// seeded origin so the viewport renders the site. If it is a task prompt,
// let the AI agent drive navigation to relevant sites instead of pre-forcing one.
```

Typed non-URL input posts no origin and lets the agent drive. The chips
deliberately bypass this by sending both `origin` and `initialPrompt`.

The permission layer is not an obstacle either. `allowOrigin()`
(`worker/session-do.ts:1471`) auto-grants any public https origin when
`autonomous` and `autoGrantNew` are both on, and both default on.
`is-private-url.ts` blocks only internal addresses. The agent is already
allowed to roam.

## What blocks it

1. **The SYSTEM prompt confines the model to the catalog.**
   `worker/agent.ts:214-220` names Allbirds, Brooklinen and Kayak explicitly,
   then says *"Prefer origin-qualified tools the user has granted. Never invent
   tools."* With no origin granted the model sees only the six-tool spine and
   has no licence to pick a destination.

2. **There is no discovery mechanism.** No web search exists anywhere in the
   codebase — zero matches for google, bing, duckduckgo or `web_search` across
   `worker/`, `shared/` and `src/`.

3. **Auto-grants are invisible.** `grantConsent` (`session-do.ts:481`) never
   broadcasts. A model-picked origin does not appear in the transcript until
   the next unrelated `state` push.

## Decisions

Settled during brainstorming:

- **Discovery:** the model picks destinations from its own knowledge. No search
  engine now; the seam for a later `web_search` spine tool is designed in but
  not built.
- **Chips:** become pure task prompts. The catalog is not deleted — it becomes
  a quality tier the agent falls into on its own when it happens to pick a
  pre-wired origin.
- **Consent:** model-picked origins keep auto-granting (no per-navigation
  prompt), but every auto-grant becomes visible in the transcript with an
  existing revoke affordance.

Rejected: driving a search engine's results page in the browser. It is
DOM-guessing on a SERP, which contradicts the "not a scraper" positioning, and
Browser Rendering is likely to be bot-blocked.

## Design

### 1. Chips post no origin

`src/pages/Home.tsx` — drop `origin` from each of the four chip objects and
from the `POST /sessions` body in the chip click handler. Send only
`initialPrompt: chip.text`. The chip path then converges with the typed-text
path that `Session.tsx:241` already documents.

No copy rewrite is required. Unpinning is what makes the existing copy true:
with no origin forced, "across 4 stores" can visit four stores and "dinner &
movie tickets" can visit a restaurant site and a cinema site.

The `origin` field stays supported on `POST /sessions` — the typed-URL path
and `recentSites` still use it. Only the chips stop sending it.

### 2. SYSTEM prompt opens the navigation model

`worker/agent.ts:214-220`. Rewrite to establish, in order:

- The model may navigate to any https site it judges relevant to the task.
- A site with no registered tools is normal: call `inspect_site`, then propose
  a manifest for approval.
- The catalog sites are named as *examples of pre-wired origins*, not as the
  available world.
- "Never invent tools" is retained. It governs tools, not origins, and remains
  load-bearing for the approval story.

The prompt must not enumerate the catalog as a closed list. If it names
Allbirds and Kayak at all, it names them as illustrations.

### 3. Auto-grants become visible

`allowOrigin()` (`worker/session-do.ts:1471`) is the single choke point — all six call sites (lines 1040, 1062, 1086, 1115, 1559, 1591) route through it.

Distinguish the two paths inside it:

- Origin already in `readConsent()` — unchanged, no broadcast.
- Origin auto-granted now — after `grantConsent`, broadcast a new
  `origin_granted` message.

New `ServerMessage` variant in `shared/protocol.ts`:

```
| { v: 1; type: "origin_granted"; origin: string; source: "model" | "user" }
```

`source` distinguishes an origin the model chose from one the user typed, so
the transcript can word them differently and so a future policy can treat them
differently without another protocol change.

Client (`src/pages/Session.tsx`): on `origin_granted`, append a `kind: "system"`
line and refresh consent state. This matches the existing lines emitted for
user-initiated grants at `Session.tsx:448` and `:474`.

No new revoke UI. `src/components/Consent.tsx:181` already renders a revoke
button per granted origin.

### 4. The `web_search` seam

Not built in this change. Recorded so the later addition does not reopen this
design:

- It lands in `SPINE` (`worker/mcp/tools.ts:10`) as an additional entry, and in `ALWAYS_ON_TOOLS` (`shared/manifest.ts:33`) — note these are two distinct lists today and both need the name.
- It returns results only. It never navigates. The model still calls
  `navigate_to`, so the consent and SSRF path is unchanged by its arrival.
- The SYSTEM prompt written in §2 must be phrased so that adding "call
  `web_search` when you do not know a suitable site" is an insertion, not a
  restructuring.

## Testing

Follows the existing one-test-file-per-module convention under `tests/`.

- `tests/agent.test.ts` — the rewritten SYSTEM prompt does not present the
  catalog as a closed list, and retains the "never invent tools" constraint.
- Consent tests — `allowOrigin` broadcasts `origin_granted` exactly once on an
  auto-grant, and does not broadcast for an already-consented origin.
- `shared/protocol.ts` — the new variant is covered by whatever exercises the
  message union.
- Home chips — the chip click handler posts a body with no `origin`.

`pnpm test && pnpm typecheck` green before each commit, per `SPRINT.md`.

## Out of scope

- **The "Search" placeholder.** `Home.tsx:31` reads "Search, ask a task, or
  enter a website...". With no search tool this is aspirational, but a task
  prompt is how searching works here, so the wording is not false. Left alone
  rather than churned twice — revisit when `web_search` lands.
- **Manifest approval.** An uncatalogued site still requires a human to approve
  each generated tool by name. This is load-bearing for the positioning and
  does not change.
- **The catalog itself.** `shared/stores.ts` is untouched.
- **Demo timing.** Unpinning removes the guarantee that a chip produces a
  result within seconds; an uncatalogued destination costs an inspect-and-
  approve round trip. Accepted deliberately: the honest path is the product.
