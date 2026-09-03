# Session as account — design

**Status:** proposed, not yet planned or implemented. No code has been written.

**Verified against `625a642`.** This repository moved four times while the spec
was being written (`74025f8` → `86afdcb` → `625a642`), and the intermediate
states differ in ways that change the claims below —
`find_local_council_on_gov_uk` and `state.consented` are absent from
`86afdcb` and present here. Every file
reference was re-checked against `625a642`. Re-check before planning if `main`
has moved again.

## Problem

The MCP surface at `/mcp` (Phase 1) and its OAuth 2.1 flow (Phase 1.5) are
built and tested. They are also, today, the *secondary* surface: the product
story is a façade page ChatGPT loads. Making `/mcp` primary — any MCP client,
any site, one consent layer — is a positioning change with one hard technical
consequence, and one live bug.

**The profile is in the browser.** `src/lib/profile-store.ts` reads and writes
`localStorage`. `fillsFrom` is resolved client-side in
`src/lib/register-all.ts:155` and merged into the tool arguments *before* they
cross the bridge WebSocket. The bless dialog is client-side too
(`register-all.ts:146`). The Durable Object has never seen a profile value.
That is not an accident — it is what makes "there is nowhere to log it" an
architecture rather than a policy.

**So `/mcp` cannot fill anything, and it reports success.**
`fill_checkout_on_allbirds_com` is steps-based with `fillsFrom` and no
`nativeName` (`shared/stores.ts:150-176`). Over MCP:

1. `buildToolList` lists it for any consented origin (`worker/mcp/tools.ts:52`).
   There is no profile check.
2. A client calls it. There is no page, so no `localStorage` and no bless.
3. `runStep` reads `args[step.from]` — `step.from` is the dotted profile path
   (`"shopper.firstName"`), which nothing supplied — so `String(undefined)`
   yields `""`, and `page.fill(selector, "")` sits inside a `catch {}`
   (`worker/session-do.ts:701-707`).
4. `runTool` returns `{ ok: true, text: "ran fill_checkout_on_allbirds_com
   at <url>" }` having filled nothing (`worker/session-do.ts:678`).

`find_local_council_on_gov_uk` has the same shape (`shared/stores.ts:180-196`,
`fillsFrom: ["address.postcode"]`). Those are the only two tools in the catalog
that declare `fillsFrom`, and both fail this way.

This is sprint item P1.4's failure mode — a fake success on an empty
effect — on the surface this design makes primary. Fixing it is not a
precondition for the design; it is the first thing the design does.

**And consent does not persist.** Granted origins live in the SessionDO `meta`
table keyed by a 64-hex token with a two-hour TTL (`session-do.ts:45`,
`:922`). A product whose claim is "holds your consent" cannot hold it for
longer than one afternoon.

Sprint item P1.3 (consent hydration) is partly addressed already — the `state`
message now carries `consented` (`shared/protocol.ts:98`, sent at
`session-do.ts:501`), so a reload re-seeds from the DO. That fixes the
reload; it does not make consent outlive the session. The durability gap is
what remains, and it is the part the product claim rests on.

## Non-goals (this design)

- **No change to the audit table shape.** `{origin, tool, field_names, ts}`.
  No value column. Ever. Carried forward from the MCP phase-1 plan and the
  manifest-generation design; restated because §Analytics is exactly where a
  reader would expect it to be relaxed.
- **No server-side profile in this phase.** §Opt-in below designs the seam;
  it does not build through it.
- **No change to the WebMCP façade.** `registerAll()`, per-tool
  `AbortController`, origin-qualified names, ChatGPT desktop discovery — all
  unchanged and still supported.
- **No new model invocation.** Nothing here puts an LLM in a call path.
- **No manifest generation.** Orthogonal; the 2026-09-03 manifest-generation
  design stands or falls on its own.

## Surfaces

| Surface | Loaded by | Role |
|---|---|---|
| `/mcp` | any MCP client, over OAuth | the product — tools for granted origins |
| `/c/<token>` console | the **human** | grant, watch, approve, revoke, read the log; holds the profile |
| `/s/<token>` façade | an agent (ChatGPT desktop) | unchanged; no longer the headline |

Today the console and the façade are one page at `/s/<token>`. This design
splits them, because the console acquires a job it cannot delegate and an
agent must not be able to do that job on the human's behalf — see §Routing an
approval. Same origin, so the profile in `localStorage` is reachable from both
and does not move.

## The account

New `AccountDO`. It holds:

- granted origins (moved out of `SessionDO`'s `meta` table)
- issued MCP client grants
- a pointer to the current live session, if any
- the audit rows (moved, shape unchanged — see §Analytics)

It does **not** hold the profile, or any field value, in this phase.

`SessionDO` becomes the *runtime*: one Chromium, the existing TTL, the existing
`alarm()` teardown, disposable. The account is the durable thing. A new session
reads its grants from the account rather than starting empty, which resolves
the durability half of P1.3 by construction rather than by re-seeding a
list that still dies with the session.

**Identity: a passkey on the console.** `README.md` states passkeys cannot work
here, and for the case it describes — logging into a *remote site* — that is
correct: the authenticator is on the user's device and the browser is in
Cloudflare's network. Logging in to mcpmatic's own console is a first-party
WebAuthn ceremony on the user's own device, with no remote browser involved.
It is the one place in this system where a passkey is exactly the right
instrument, and the README's claim needs the narrowing clause "for the target
site" added rather than being contradicted.

The capability URL does not go away. It remains how a session is addressed and
how the façade is reached without a cookie. It stops being the *only* identity.

## Approval: suspend and resume

The mechanism that makes MCP-primary compatible with a client-side profile.

**The trigger is missing fills, not declared fills.** `runTool` does not ask
whether the manifest declares `fillsFrom`; it asks which declared paths are
absent from `args`:

```ts
const missing = (manifest.fillsFrom ?? []).filter((p) => args[p] === undefined);
```

Empty — run the steps, the caller already supplied them. Non-empty — the
approval path below.

This is what stops the façade path prompting twice. `runTool` has two callers:
`callTool` for MCP (`session-do.ts:250`) and `onToolExec` for the façade
(`:439`). On the façade path `register-all.ts` has already run its client-side
`BlessGate` (`:146`) and merged the resolved fields into the arguments
(`:164`) before they cross the wire, so `missing` is empty and nothing prompts
again. One rule, no entry-point branching inside `runTool`.

**One guard at the MCP entry.** `callTool` strips any argument key matching a
declared profile path before calling `runTool`. Without it a client could pass
`{"address.line1": "…"}` and route around approval entirely — and the audit
row would then name profile fields that were never the user's profile. The façade
path is untouched, because it merges *after* its own bless.

With `missing` non-empty:

1. Mint `pendingFill { id, origin, tool, fieldNames[], expiresAt }`. It carries
   no values, because at this point none exist anywhere on the server.
2. **No bridge WebSocket attached** — `this.ctx.getWebSockets()` is empty —
   return
   `{ ok: false, text: "needs-console: open <console url> to approve
   shopper.firstName, address.line1, …" }`.
   Explicit, actionable, and never a fake success. This step alone closes the
   bug in §Problem.
3. **Attached** — broadcast `approval_request` over the existing bridge. The
   console renders the existing `BlessGate`; it is already the component that
   asks "send these fields to this origin?".
4. Human approves — the console calls `profileStore.resolve(fieldNames)` and
   replies `approval_result { id, ok: true, fills }`. Denies — `{ id, ok:
   false }`, and `runTool` returns `{ ok: false, text: "user denied: profile
   fields not sent" }`, the same string the façade path already throws.
5. The DO merges `fills` into `args`, runs the steps, writes the audit row
   (`{origin, tool, fieldNames, ts}`, unchanged), and **discards `fills`**.
   Values live in one local variable for the duration of one call. Nothing
   persists them; there remains nowhere to log them.
6. Timeout — **45 seconds**, and the number is load-bearing. The MCP SDK's
   `DEFAULT_REQUEST_TIMEOUT_MSEC` is 60 000
   (`@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:8`), so our timeout
   must fall *under* the client's or the client abandons the request while the
   human is still reading the dialog, and the approval lands nowhere. Returns
   `{ ok: false, text: "approval timed out" }`.

   45 seconds is tight for a human. The SDK's `resetTimeoutOnProgress` option
   means a server that emits progress notifications extends the client's
   window, so the DO can hold a pending approval open far longer by pinging
   progress while it waits. That is the better answer and should be
   implemented in Phase A; the 45-second floor is what applies to a client
   that does not opt in.

Protocol additions, `shared/protocol.ts`, additive and still `v: 1`:

```ts
// ServerMessage
| {
    v: 1;
    type: "approval_request";
    id: string;
    origin: string;
    tool: string;
    fieldNames: string[];
    expiresAt: number;
  }

// ClientMessage
| {
    v: 1;
    type: "approval_result";
    id: string;
    ok: boolean;
    /** Keyed by dotted profile path, matching `resolveFields` output. */
    fills?: Record<string, string>;
  }
```

`fills` keys are the dotted paths (`"address.postcode"`), which is what
`resolveFields` returns and what `step.from` already reads — so the merge is
the same merge `register-all.ts:164` performs today, moved to the other end of
the wire.

**This inherits P0.1's rule: complete on every exit path.** Deny, timeout,
console disconnect mid-approval, page reload, and DO hibernation each resolve
the pending call with an explicit failure. A suspended `runTool` must never
strand an MCP client's request. The in-flight request keeps the DO alive for
the duration, so the timeout can be a plain timer; a hibernation that happens
anyway resolves as a disconnect.

**Shape note.** This is the same suspend-a-turn-and-resume pattern as the
existing `tool_call` / `tool_result` pair, including its correlation-id
discipline. It should read as a sibling of that code, not a new idiom.

## Routing an approval: the console is its own route

**Who reads the dialog?** The console and the façade are the same page today,
and ChatGPT desktop loads that page. A bridge socket may therefore be attached
because *an agent* opened `/s/<token>`, and an approval broadcast would render
a `BlessGate` inside an automated browser with nobody in front of it. The
45-second timeout bounds the damage; it does not answer the question.

**Split the routes.** `/s/<token>` stays the façade — what an agent loads,
where `registerAll()` runs, with no profile store and no approval UI mounted.
`/c/<token>` is the console — human-loaded, mounts the profile store and the
approval UI, and declares `role: "console"` when it opens its bridge socket.
Approval requests route only to sockets that declared `console`. None attached,
`needs-console`.

Same origin, so `localStorage` is shared between the two views and the profile
does not move. What changes is that the façade becomes *structurally* incapable
of answering an approval rather than merely unlikely to, and §Surfaces becomes
literally true instead of aspirational.

**Approval authority is bearer-token authority.** The capability token now
gates more than browser control: whoever holds it can open a console and be
asked to release profile fields. Two things bound that. The profile is
per-browser `localStorage`, so a stolen token opened elsewhere resolves
whatever profile *that* browser holds, not the victim's — and with nothing
stored, `src/lib/profile-store.ts:12` falls back to `SEED_PROFILE`. The
realistic outcome of a stolen token is an attacker approving the release of
demo data to a site they chose themselves. Not nothing; not the user's address
either. Phase B's account login is what actually reduces this, by making the
token a session handle rather than the only credential.

## Tool listing honesty

`buildToolList` appends a fixed sentence to the description of any tool with
`fillsFrom`: "Requires human approval in the mcpmatic console." A planning
client then knows the cost before it calls, rather than discovering it in an
error. The tool stays listed — hiding it would make the surface depend on
whether a browser tab happens to be open, which is worse.

## Analytics for site owners

**Corrected during Phase C.** This section claimed the audit table was already
the right shape and that telemetry was only a read path over it. Both halves
were wrong, and building it exposed why.

The audit table is `{origin, tool, field_names, ts}`. It has no outcome, no
failure reason and no duration, so not one of the four metrics below is
derivable from it. And telemetry cannot be account-scoped at all: a merchant
needs calls from every visitor, and an account's rows are one person's.

So site telemetry lives in its own store, `SiteDO`, keyed by origin, holding
`{tool, ok, reason, ms, ts}` and nothing that identifies a caller. That is a
better answer to this spec's own constraint than the one it proposed: the
reason the audit table must never gain a value column is that it is a person's
privacy record, and the fix is a second record for a second audience — not a
first record made to serve both.

`GET /site/<origin>/telemetry`, scoped to a single verified origin:

- per-tool call counts
- ok / fail split
- failure class
- latency

**The failure classes are the product — and they are not free yet.**
`nativeFailure()` (`worker/session-do.ts:991`) distinguishes exactly three:
`threw`, `no-webmcp`, and not-registered. It does **not** distinguish a schema
mismatch; a native call rejected for a bad argument shape arrives as `threw`,
indistinguishable from any other exception.

That matters, because schema mismatch is the single most valuable thing to tell
a merchant — *"your `update_cart` rejects 40% of agent calls because its schema
requires a field your own storefront never sends"* — and it is the sentence
nobody else can produce, since nothing else calls their WebMCP tools from
outside their page. Phase C must therefore **add** that classification at the
call site in `callNativeTool`, not merely aggregate rows that already exist.
Costing that honestly is the difference between a two-day phase and a two-week
one.

Boundaries, stated so they are not quietly crossed later:

- No user values. There are none — see §Approval step 5.
- No cross-origin joins. A site owner sees their origin, never a path through
  it.
- No session identifiers, and no per-user counts.
- Origin ownership is proved before any read: the owner publishes a token at
  `/.well-known/mcpmatic.txt`, and that token is then the read credential —
  whoever can put a file on the site is exactly the audience. The fetch runs
  the same fail-closed SSRF guard as every other navigation, and a refused read
  returns one answer for "not verified", "wrong token" and "unknown origin", so
  it cannot become an oracle for which origins hold data.

This requires audit rows to outlive the session, which is why they move to the
`AccountDO` in §The account. The move is a relocation, not a reshape.

**One correction the telemetry forces.** Both entry points record
`manifest.fillsFrom` unconditionally — `callTool` at `session-do.ts:258`,
`onToolExec` at `:461` — so a call that resolved no fields still logs the
declared names. A native-tool call on a manifest that declares `fillsFrom`
produces a row naming fields that never moved. Aggregated, that overcounts
profile usage. The row should record the fields **actually resolved** (the keys
of the approval's `fills`, or of the façade's merge), not the manifest's
declaration. The column is unchanged; only its provenance is.

## Opt-in server-side profile (designed, not built)

A per-account flag `unattendedFills`, default `false`. When a user turns it on,
the profile is stored on the account and the DO resolves `fillsFrom` directly,
with no console attached and no approval round trip. Every claim about the
profile then becomes scoped to that choice rather than spent on the product as
a whole:

> Off by default. When you turn it on, your profile is stored on our servers
> and these tools run without you.

Not built in this phase. The seam is that §Approval's step 3–4 is a *resolver*
with one implementation (`ask the console`); the opt-in adds a second (`read
the account`) behind the same interface. `runTool` should not learn which one
it got.

## What stays untouched

Audit table shape · `isPrivateUrl` on every navigation, whoever initiated it ·
origin-qualified tool names · consent gates listing, not just execution · no
LLM in any hot path · the WebMCP façade, `registerAll()`, and per-tool
`AbortController`s · the two bearer shapes at `/mcp`.

## Testing

Same conventions as `tests/`:

- **The bug first.** A `runTool` test that calls a `fillsFrom` tool with no
  WebSocket attached and asserts `ok: false` with `needs-console`. This test
  fails against `main` today; it is the regression proof for §Problem.
- **Approval round trip.** Fake WebSocket, assert `approval_request` is
  broadcast with the right `fieldNames`, reply `approval_result` with fills,
  assert the steps received the merged args and that the audit row lists the
  field names and no values.
- **Every exit path.** Deny, timeout, disconnect-mid-approval. Each resolves
  the pending call with an explicit failure and leaves nothing pending — the
  P0.1 discipline, applied to this pair.
- **Listing.** `buildToolList` marks `fillsFrom` tools and leaves others alone.
- **No double prompt.** A façade-initiated call whose args already carry the
  resolved fields runs straight through: `missing` is empty, no
  `approval_request` is broadcast. The regression this guards is a user
  clicking `BlessGate` twice for one action.
- **No self-fill over MCP.** `callTool` strips caller-supplied profile paths,
  so a client passing `{"address.line1": "…"}` still takes the approval path
  and the audit row still names only what was actually resolved.
- **Routing.** An approval is not delivered to a bridge socket that did not
  declare `role: "console"`; with only a façade socket attached the call
  returns `needs-console`.
- **Account.** A second session under one account inherits granted origins; an
  expired session does not expire the account; revoking an origin on the
  account removes it from a live session's tool list.
- **Telemetry.** Aggregation returns no values and no cross-origin rows;
  unverified origin reads are refused.

## Phasing

- **A — approval.** Fix the fake success, add suspend/resume, mark the listing,
  and split the console from the façade (§Routing — added after review and
  belonging here, because without it the approval can be delivered to an
  agent's browser). Touches `session-do.ts`, `protocol.ts`, `mcp/tools.ts`,
  `bridge-role.ts`, the router and the console. Ships the trust claim on its
  own.

  One thing the routing work surfaced that the design did not predict:
  `acceptBridge` closed every existing socket on connect, correct when there
  was one view and wrong with two — opening the console would have
  disconnected the agent. It replaces only a socket of the same role now.
- **B — account.** `AccountDO`, passkey login, durable consent, audit rows
  relocated.

  **A session is claimed, not replaced.** The console POSTs its account id to
  `POST /s/<token>/account`; the `AccountDO` records the session and returns
  the union of its grants and the session's, and the `SessionDO` records the
  account id. From then on `grantConsent` writes through to the account.
  Unclaimed sessions keep working exactly as today — a capability URL with no
  account behind it is still a working two-hour session. That is what keeps
  "no login, no key, no install" true while giving consent somewhere durable
  to live for people who want it.

  **Built, with two deliberate departures from the paragraph above.**

  The route is `POST /s/<token>/account`, not `/account/claim`: it matches the
  existing `/s/<token>/consent`, and keeps the session token out of a request
  body.

  Identity is a two-layer thing, and the layering is the point. The account id
  is 256 bits the console generates and keeps in `localStorage` — a bearer
  credential of the same class as the session token in the URL. That alone
  buys durable consent with no auth system at all, which is what "no login" is
  worth protecting, and it is what an account is until someone asks for more.

  A **passkey** is the second layer, and it is built. A discoverable credential
  carries the account id as its `userHandle`, so a login needs no username and
  names no account up front — the assertion says whose it is. Signing in adopts
  that account, re-claims the session under it, and the grants come back. That
  is what lets an account survive cleared storage and reach a second device.

  This works here for the reason `README.md`'s passkey caveat does not apply:
  the authenticator is on the user's own device and the ceremony is
  first-party. The caveat is about logging in to a *remote site* through a
  browser in Cloudflare's network.

  Challenges live in the KV bound as `OAUTH_TOKENS`, prefixed. A login
  challenge is issued before anyone knows which account will answer it, so it
  cannot live in that account's Durable Object. Single-use on read, five-minute
  TTL.

  **Consent is mirrored, not read through.** `readConsent()` is synchronous and
  sits in hot paths (`consented()`, the `state` message); making it await a
  second Durable Object would ripple through the class for no gain. So the
  session keeps its local list as the read path and the account is the durable
  source that repopulates a *new* session. `grantConsent` writes both, the
  account write via `waitUntil` so consent still answers without waiting on a
  second DO.

  **Audit rows are mirrored too**, same reasoning and same shape: the session
  keeps its rows as the live view it broadcasts, the account keeps the durable
  copy, `{origin, tool, field_names, ts}` on both sides with no value column.
  `GET /s/<token>/audit` reads the account's, falling back to the session's
  when there is no account. Phase C's dependency on rows outliving a session is
  satisfied.

  Extracting the row mapper turned up a fault worth recording: the listing did
  a bare `JSON.parse` on `field_names`, so one corrupt row threw and cost the
  entire log. A row that will not parse is now kept with an empty field list —
  the row is evidence a tool ran, and only the field list is missing. Closes the durability half of P1.3.
- **C — telemetry.** Built. `SiteDO` per origin, the ownership proof above,
  and the schema-mismatch class the business case rests on: `callNativeTool`
  now checks arguments against the tool's own declared schema (observed by
  `discoverNativeTools`) and classifies rather than calls when they cannot
  satisfy it. `checkArgs` is a deliberate subset of JSON Schema — required,
  declared types, closed objects — because it exists to classify a failure, not
  to validate input. With no usable schema it passes: "we do not know" must
  never reach a site owner as their bug.

A and B are independent — A is first because it fixes a live bug, not because
B needs it. **C depends on B**: telemetry requires audit rows that outlive a
two-hour session, which is the relocation B performs.

## Open questions

- Whether an approval should be able to carry a *duration* ("approve address
  fields on this origin for this session") or must be per-call. Per-call is
  this design; the `pendingFill` record has room for a scope field.
- Whether `needs-console` should include a deep link to `/c/<token>` focused on
  the pending approval. It would put a capability URL into an MCP tool result,
  which then lives in the client's transcript — a different exposure from the
  `Referrer-Policy: no-referrer` discipline the façade already keeps, and one
  the answer should weigh explicitly.
- Whether the `role: "console"` declaration needs to be anything stronger than
  a self-declaration on the bridge socket. It is not a security boundary
  against the token holder — see §Routing — but if a future agent surface can
  reach `/c/<token>`, "the façade cannot answer approvals" stops being
  structural.
- How an account revokes a specific MCP client grant without invalidating the
  others — Phase B needs this and RFC 7009 revocation is the obvious shape.
- Whether telemetry should be offered to origins that have *never* consented
  to being driven, or only to those that have adopted WebMCP. The second is
  narrower and easier to defend.
