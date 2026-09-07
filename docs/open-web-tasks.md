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

Both flags genuinely default on: `autonomousFromStored` (`shared/autonomous.ts:31`)
resolves an absent row to `true`, `readAutoGrantNew` treats anything but `"0"`
as on, and `listConsent` returns the resolved values, so the console toggles
match server behaviour. No manual grant step is required for the agent to reach
a new site.

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

4. **Every session inherits every origin the account ever granted.**
   `grantConsent` writes through to the account (`session-do.ts:489`) so a
   grant outlives the session. `AccountDO.claim` (`account-do.ts:83`) then
   returns `unionOrigins(await this.listGrants(), sessionGrants)` — the whole
   historical list — and `claimAccount` (`session-do.ts:410`) writes it into
   session consent with `this.writeConsent(grants)`. `Session.tsx:202` takes it
   verbatim as `seeded`.

   Observed: clicking "Plan and price my trip in one shot" produces a session
   consented to `allbirds.com`, because an earlier session granted it. The
   Consent panel shows it granted, "Connected to ..." announces it, and
   `buildToolList` registers its tools, so the model doing a trip task is also
   holding `search_catalog_on_allbirds_com`.

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
- **Account grants stop seeding session consent.** The account list is a
  capability ("this origin may be used without asking"), not active session
  state. It must not drive what the Consent panel lists or what "Connected
  to ..." announces.
- **Model-picked origins stay session-scoped.** They auto-grant for the session
  and never reach `AccountDO.grant`, so the durable set does not grow every
  time the agent wanders.
- **A page always renders.** The agent's first tool call is a navigation, with
  a client-side fallback if nothing has rendered.

Rejected: driving a search engine's results page in the browser. It is
DOM-guessing on a SERP, which contradicts the "not a scraper" positioning, and
Browser Rendering is likely to be bot-blocked.

Rejected: guessing an origin from the task text before the model runs. It is
pinning through the back door, and a wrong guess is worse than a standby
message.

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
- **The first tool call of a task turn is a navigation.** The model picks a
  destination and calls `navigate_to` before anything else, so a live page
  renders as early as possible. See §5.

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

### 5. Session consent stops inheriting the account

The account grant list serves two jobs today and must serve only one.

- **Capability** — "this origin may be used without asking again." Keep it.
- **Active session state** — what the Consent panel lists and what
  "Connected to ..." announces. Stop deriving this from the account.

`claimAccount` (`worker/session-do.ts:410`) must stop calling
`writeConsent(grants)` with the account's full list. Claiming an account
records the account id and merges the session's own grants *into* the account;
it does not pull the account's history back down into the session.

`Session.tsx:202` correspondingly stops assigning `seeded = claimed.consent`.
`seeded` comes from the session's own consent only — the origin passed to
`POST /sessions`, plus whatever this session grants as it runs.

This costs little now that auto-grant is on by default: an inherited grant only
ever saved a click the agent no longer needs. `AccountDO`'s durable list stays
as the audit and cross-session record, and `listHistory` still reads it.

**Model-picked origins do not write through.** `grantConsent` currently always
calls `ACCOUNT.grant(origin)`. It needs the `source` distinction from §3: a
user-typed origin writes through as today; a model-picked origin grants for the
session only. Without this, an agent that roams permanently enlarges the
account's grant set — the same defect, arriving by a new route.

### 6. A page always renders

Two mechanisms, in order.

**Primary — the agent navigates first.** Per §2 the first tool call of a task
turn is `navigate_to`, so a live page appears as soon as the model responds.
The existing standby copy (`src/components/Viewport.tsx:139`) covers that gap
and needs no change.

**Fallback — the client forces a render.** If no `frame` has arrived within
8 seconds of the session becoming ready, the client navigates to the most
recent origin from `recent-sites`, or to a neutral default when there is none.

The fallback must be labelled as one. It is the only path that can put a site
on screen unrelated to the task, which is the confusion §5 exists to fix, so
its transcript line says so explicitly — "nothing opened yet; showing your last
site" — rather than the "Connected to ..." wording used for task origins. It
must not mark the origin as part of the task's consent set in the Consent
panel.

The 8-second threshold is a starting value, not a measured one.

## Testing

Follows the existing one-test-file-per-module convention under `tests/`.

- `tests/agent.test.ts` — the rewritten SYSTEM prompt does not present the
  catalog as a closed list, and retains the "never invent tools" constraint.
- Consent tests — `allowOrigin` broadcasts `origin_granted` exactly once on an
  auto-grant, and does not broadcast for an already-consented origin.
- `shared/protocol.ts` — the new variant is covered by whatever exercises the
  message union.
- Home chips — the chip click handler posts a body with no `origin`.
- `claimAccount` records the account and merges the session's grants upward,
  and does **not** write the account's history into session consent. Regression
  test for the observed bug: a session seeded with `kayak.com`, on an account
  that has previously granted `allbirds.com`, ends with consent `[kayak.com]`.
- `grantConsent` writes through to `AccountDO` for a user-typed origin and does
  not for a model-picked one.
- The render fallback fires only when no frame has arrived, and its transcript
  line uses the fallback wording rather than "Connected to ...".

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
