# Feature Specification: WebMCP Façade

**Status:** ACTIVE — architecture record for an external submission
**Intent:** `infra`
**Domain:** `ai`
**Created:** 2026-08-26
**Updated:** 2026-08-31
**Target:** OpenAI WebMCP Challenge. Submissions close **2026-09-03 13:00 PDT**
  ([Devpost rules](https://webmcp.devpost.com/rules)). After that timestamp the
  live URL, public repo, and Devpost entry must not be edited until winners
  are announced.

The **submission demo** (split-view, build order, remaining calendar) is
defined by [`PLAN.md`](./PLAN.md). This file is the architecture and security
record. Where they used to disagree, PLAN wins on demo shape; this file has
been patched so they no longer disagree on audit, hosting, or the consumer API.

---

## 0. Read this first — where the code lives

The deliverable is **not** in this repo. The challenge requires a public
repository containing an open-source license file; the root `LICENSE` here is
`Proprietary License / Copyright (c) 2025 FastCloud Labs`. Shipping the
submission from this tree would mean open-sourcing WorkChi.

| Artefact | Home |
|---|---|
| This spec (architecture record) | `docs/02-features/webmcp-facade/SPEC.md` |
| Submission demo plan | `docs/02-features/webmcp-facade/PLAN.md` |
| Submission code | **this repo (`mcpmatic`)** |
| Reusable prior art | `apps/workers/browser-mcp` (read, port, do not import) |

Nothing in this spec adds a table, a Server Action, or a route to WorkChi, so
the RBAC 5-step and the `*.actions.test.ts` pairing rule do not apply. The
tenant-isolation rule *does* apply in spirit and is restated in §4 as
per-session isolation.

---

## 1. Feature Overview

### 1.1 Description

A web page that declares WebMCP tools on behalf of a website that has none, and
executes them by driving a remote browser over CDP.

ChatGPT's desktop built-in browser speaks WebMCP today. It reads tools from the
DOM of the page it has loaded. So a page can register tools whose handlers
operate a *different* site running in a Cloudflare Browser Rendering session —
making the façade page a WebMCP adapter for an arbitrary origin, with no browser
extension, no HTML proxying, and no cooperation from the target site.

The submission demo additionally puts an in-page chat panel on that same
page. That panel is a WebMCP *consumer* (`getTools` / `executeTool`), not a
private channel around the standard. See PLAN §The one correction.

### 1.2 Why this shape and not the alternatives

| Rejected | Reason |
|---|---|
| Browser extension injecting into the real origin | Works, but the challenge is judged partly on the human-agent experience; an extension means we ship the agent too. Also excluded by the operator's constraint. |
| Reverse-proxying third-party HTML through a Worker | Passkeys are bound to the origin's RP ID and cannot be proxied. Plus cookie custody, CSP stripping, and unbounded runtime-URL rewriting. |
| Headless agent driving the browser with no human | WebMCP becomes decorative — we would own both ends of the protocol and could delete it with no change in behaviour. Fails "thoughtful use of WebMCP" / the judging criterion **WebMCP Leverage**. |
| Cloudflare's shipped WebMCP edge injection | Own-zone only, and ships two fixed tool packs (C2PA Content Credentials, Site MCP proxy). It does not synthesise a tool surface from page content. That gap is this project. |
| A private handler list next to `registerTool` | Looks like consumption; is a bypass. In-page agents discover via `getTools()` and invoke via `executeTool()`. See §1.3. |

### 1.3 What is load-bearing

The test applied to every design decision: **abort the registration `AbortSignal`
(or otherwise remove `document.modelContext`) and does the product still
exist?** Here it does not.

Concretely, for the in-page agent:

- Discovery is `document.modelContext.getTools()`, not a list of `execute`
  closures stashed at registration time.
- Invocation is `document.modelContext.executeTool(tool, input)`, not calling
  those closures directly.
- ChatGPT's browser agent uses its own discovery path; it still executes the
  same `registerTool` handlers on the façade document.

That is the difference between this and the "LLM drives a headless browser"
category. A test that only checks "the panel's list equals what
`registerAll()` stored" is not this test.

---

## 2. Architecture

### 2.1 Request path

```
Browser (ChatGPT desktop, or any browser + polyfill)
  │  loads https://<facade-host>/s/<sessionToken>
  ▼
Façade page
  registerAll() ──▶ document.modelContext.registerTool(…, { signal })
       │
       ├─ ChatGPT browser agent  (platform discovery)
       └─ in-page chat panel     (getTools / executeTool)
              │  WebSocket  (chat, tool_call, tool_result, frame, input)
              ▼
         Session Durable Object  (one per session)
           • OpenAI turn (key server-side only)
           • CDP session, screencast, input relay
           • audit log in DO SQLite
              │  Browser Rendering binding
              ▼
         Chromium  ── Playwright / CDP ──▶ target origin
                      (real cookies, real CSP; no WebMCP injection)
```

A tool call travels façade `execute` handler → WebSocket → DO → Playwright →
target site, and the result returns the same way. The façade page holds no
browser state. WebMCP tools are registered on the **façade** document ChatGPT
loaded, never on the target origin. Driving the target is Playwright from the
DO; `page.addInitScript()` is not part of the v1 path.

The OpenAI key never reaches the page. The in-page agent therefore:

1. Sends the user message, plus the schemas from `getTools()`, up to the DO.
2. Receives a `tool_call` from the DO.
3. Invokes `executeTool` on the page.
4. Returns `tool_result` to the DO for the next model turn.

### 2.2 Hosting stack

v1 is the submission. Rows marked *deferred* are not built for the challenge.

| Component | Technology | Why this and not the alternative |
|---|---|---|
| Façade page | **Workers Static Assets**, dedicated zone or subdomain | Must be a plain public HTTPS page the user can grant ChatGPT access to. No framework — a small reviewable bundle helps judging. Not Pages: Static Assets keeps page and Worker in one deploy. Required response headers: §4.5. |
| Session bridge | **Durable Object**, one per session, **WebSocket Hibernation API** (`state.acceptWebSocket`) | A stateless Worker cannot give session affinity. An active screencast keeps the DO awake, so hibernation only helps *between* sessions, not during them. Still worth using. |
| Remote browser | **Browser Rendering** `BROWSER` binding + `@cloudflare/playwright` | Proven in `apps/workers/browser-mcp`, including `connect()` reattach. Launch with **`recording: false`** — Cloudflare session recording would capture keystrokes at the platform layer. |
| Viewport | CDP `Page.startScreencast` (`format: "jpeg"`, capped `maxWidth`) over the **same DO WebSocket** | Ack every `Page.screencastFrame` or the stream stalls. Never buffer past the most recent frame. Pause when the client tab is hidden. Screenshot polling is the emergency fallback, not the design. WebRTC is out of scope. |
| Per-session audit trail | **DO SQLite storage** | Colocated and transactional with the session that produced it. Schema: §4.2. Does not belong in D1. |
| Manifests | **Hand-authored JSON** in the submission repo | Generation, a KV `origin::domHash` cache, a D1 registry, and Cloudflare Queues are **deferred**. A tool call must never block on LLM generation; v1 simply does not generate. |
| LLM | **OpenAI API directly**, from the DO only | The submission repo is MIT; `@workchi/llm-router` is proprietary and cannot be a dependency. The key never reaches the page. |

### 2.3 Browser engine: Chromium, not Kitesurf

Kitesurf is excluded from the interactive path on our own measurements in
[kitesurf-crawler-provider/EVALUATION.md](../kitesurf-crawler-provider/EVALUATION.md):
**5.3–8.3× slower, 17.9s on stripe.com**. Cloudflare additionally documents no
persistent authenticated sessions and no bot-challenge negotiation with real TLS
fingerprints — both disqualifying for a logged-in site.

Kitesurf is admitted for **offline manifest generation over public pages only**,
which is out of scope for the submission. Same posture as the crawl cron.

### 2.4 Tool surface — imperative only, for this submission

ChatGPT's built-in browser
([learn.chatgpt.com/docs/webmcp](https://learn.chatgpt.com/docs/webmcp)):

- **Does not support the declarative API** (`toolname` / `tooldescription` on
  forms are not site tools).
- **Does not discover tools registered in iframes**, same-origin or not.
- Site tools are unavailable in Enterprise/Edu; **GPT-5.6 Luna has WebMCP
  disabled** — the demo must use Sol or Terra.
- Tools must be registered in JavaScript on the **top-level** page.

So v1 is **imperative `registerTool` on the façade**, from hand-authored
manifests. A `registerTool` entry's handler replays a bound action sequence
against the remote page via the DO. Execution is deterministic; **no LLM in
the hot path**.

Declarative synthesis and LLM generation (`origin::domHash` → snapshot →
manifest) remain a later WorkChi track, not the judged deliverable.

### 2.5 Tool surface relevance

Registering every discovered tool floods the agent's context and measurably
degrades tool selection. Scoping the registered set to the remote browser's
current view, and re-registering on navigation, is a product feature.

WebMCP has **no `unregisterTool()`**. A second `registerTool` with the same
`name` rejects with `InvalidStateError`. Re-registration is: hold an
`AbortController` per tool, `abort()` the previous signal, then register
again. Abort-and-re-register under the same name with a new schema while a
call is in flight is a documented race — do not do it.

Whether ChatGPT's browser picks up `toolchange` mid-session is still an
open spike (PLAN). **Default for the submission is the documented fallback:**
a fixed generic surface plus `get_page_state`. Relevance-scoping ships only
if that spike lands and calendar remains.

---

## 3. Interfaces

### 3.1 Session lifecycle

| Route | Purpose |
|---|---|
| `POST /sessions` | Create a session; returns an unguessable `sessionToken` and the façade URL |
| `GET /s/:sessionToken` | The façade page. **No login** — see §4.1 |
| `WS /s/:sessionToken/bridge` | Page ↔ DO channel: tool calls, results, tool-list changes, viewport frames, chat. The long-lived token is not placed in a query string on this URL. |
| `POST /s/:sessionToken/consent` | Human grants a specific origin (§4.2). Gates **registration**, not only the chat panel. |
| `DELETE /sessions/:sessionToken` | Tear down browser and DO state |

### 3.2 Tools always present

Independent of any origin-specific manifest:

- `get_page_state` — text description of the remote view. **Required on the
  spine**, not a fallback: the model cannot see the remote DOM, and a
  `<canvas>` is opaque to the accessibility tree. ChatGPT *might* screenshot
  the façade; that is not a contract.
- `list_available_origins` — what this session may act on.
- `navigate_to(origin)` — subject to consent **and** the SSRF guard (§4.4).

---

## 4. Security

### 4.1 Why the façade page cannot require a login

ChatGPT must be able to load the page, and its browser will not carry our
session cookie. Authorisation therefore rides on a **capability URL**: a
high-entropy `sessionToken` in the path, short TTL, single active browser
binding, revocable.

The token is the session's only credential. It is never placed in a query
string. A path token still leaks via `Referer`, Cloudflare request logs, and
browser history, so:

- the façade response sends `Referrer-Policy: no-referrer` (§4.5);
- application logs never record the raw path or token;
- TTL is short and `DELETE` revokes.

### 4.2 The permission-model obligation

ChatGPT's own model is **per-site**: the agent must be granted access to a site
before using its tools, and sensitive actions require confirmation. A façade
that fans out to arbitrary origins routes around that gate — the user grants
`facade-host`, and tools then act on `kayak.com`.

This is not acceptable as a side effect, and OpenAI engineers are judging the
submission. Required, not optional:

1. **Origin-qualified tool names and descriptions** — `search_flights_on_kayak_com`,
   never `search_flights`. Names are WebMCP-legal: 1–128 chars, ASCII
   alphanumeric plus `_`, `-`, `.` only.
2. **Explicit per-origin consent before any tool for that origin is
   registered.** No consent, no `registerTool`. Gating only the chat panel
   leaves ChatGPT unconstrained.
3. **Audit trail** persisted in DO SQLite, visible on the page. The row is
   `{origin, tool, fieldNames[], timestamp}` — **field names, never argument
   values**. There is no column that could hold a keystroke or a profile
   field. "We don't log it" is a policy; "there is nowhere to log it" is an
   architecture.

`fillsFrom` resolution and the field/origin disclosure run **inside the
registered `execute` callback**, at call time. Then both ChatGPT and the
in-page agent hit them. They do not live in the in-page agent's chat loop.

Framed correctly this is a feature: the permission model is *extended* to sites
that cannot yet declare tools, not bypassed.

### 4.3 Session isolation

One browser per DO, one DO per `sessionToken`. A tool call carries no origin or
session identifier from the page — both are read from DO state, the same rule as
`workspaceId` coming from the session and never from the payload.

Tests must actually refuse a foreign session token on this DO, not merely
assert that two UUID strings are different.
`browser-mcp`'s `workspace-isolation.test.ts` is not the pattern to copy.

### 4.4 SSRF

Port `is-private-url.ts` and `doh-resolve4.ts` from `browser-mcp` unchanged,
including fail-closed behaviour on resolver error. Apply the same guard to
**every** user-supplied navigation target: `navigate_to` **and** a URL the
human types into the viewport. A navigation is an SSRF vector regardless of
who initiated it.

### 4.5 Required façade response headers

`registerTool` rejects with `SecurityError` unless the agent cluster is
origin-keyed (WebMCP spec, except `file:`), and with `NotAllowedError` unless
the document is allowed to use the `tools` feature. Missing either is a silent
total failure of the judged path.

```
Origin-Agent-Cluster: ?1
Permissions-Policy: tools=*
Referrer-Policy: no-referrer
```

---

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Tool re-registration mid-session is not picked up by ChatGPT** | Kills §2.5 | Spike if calendar allows. **Submission default: fixed generic surface + `get_page_state`.** Re-registration, if attempted, uses `AbortSignal` first. |
| In-page agent bypasses `executeTool` | Fails WebMCP Leverage: deleting `modelContext` does not break the panel | Load-bearing test: `executeTool` is invoked; aborting registration removes the panel's tools. |
| `registerTool` `SecurityError` / `NotAllowedError` | Judged path is dead | §4.5 headers on the façade response. |
| Human must log into the target inside a remote browser | Trust friction; passkeys cannot work (authenticator is on the user's device) | Demo on password/OAuth logins. State the passkey limit in the README rather than hiding it. |
| Browser Rendering concurrency limits | Caps concurrent sessions | Confirm the account limit before the demo; queue beyond it. |
| Shopify already ships WebMCP across millions of storefronts | A storefront demo shows nothing new | Named targets in PLAN. Do not demo on Shopify. |
| ChatGPT built-in browser does not support declarative WebMCP or iframe tools | Generation-from-forms cannot score | Imperative `registerTool` on the top-level façade only (§2.4). |
| GPT-5.6 Luna has WebMCP disabled; Enterprise/Edu have no site tools | Demo appears broken | README: use Sol or Terra in ChatGPT desktop, personal/team workspace. |
| Chrome without the WebMCP flag has no `document.modelContext` | In-page agent has no tools | `@mcp-b/webmcp-polyfill` (or equivalent) when the native API is missing. ChatGPT desktop is the judged consumer. |
| Deadline confusion (17:00 vs 13:00 PDT) | Missed freeze | Governing time is **13:00 PDT 3 Sep 2026**. Submit 2 Sep night / 3 Sep morning. |

---

## 6. Acceptance criteria

1. A session can be created, and the façade URL loads in ChatGPT's desktop
   built-in browser with no login.
2. ChatGPT lists tools registered by the façade page for a target origin that
   has no WebMCP support of its own.
3. ChatGPT calls a tool; the action is observably performed on the real site in
   the remote browser; the result reaches the model.
4. Navigating the remote browser changes the registered tool set **or** the
   documented fallback from §5 is in place (fixed surface + `get_page_state`).
5. A tool for an origin without consent is never registered, and attempting one
   is refused and audited.
6. `get_page_state` returns enough for the model to choose a next tool without
   seeing the DOM.
7. A private-IP or rebinding navigation (`navigate_to` or human-typed URL) is
   refused, fail-closed.
8. The in-page agent discovers tools via `getTools()` and invokes them via
   `executeTool()`. Aborting registration removes those tools from the panel.
9. An audit row for a profile-injecting call contains field *names* and no
   values. Input events produce no audit row and no storage write.
10. Public repo, MIT `LICENSE`, README with setup, hosted live URL, <3 min
    demo video **with audio**. After **2026-09-03 13:00 PDT** none of those
    three artefacts are edited.

---

## 7. Phasing against the deadline

The original seven-day table is expired. Remaining calendar and cut line live
in [`PLAN.md`](./PLAN.md) §Build order.

v1 in, judged:

- Session DO + WebSocket + façade + §4.5 headers
- One hardcoded tool **and** `get_page_state`, via `registerTool`
- In-page consumer on `getTools` / `executeTool`; OpenAI key in the DO
- CDP screencast + input + coordinate mapping
- Per-origin consent before registration; bless / `fillsFrom` inside `execute`
- Audit schema with no value column
- Hand-authored manifest for the named spine origin

v1 out, deferred:

- LLM generation, KV `origin::domHash`, D1 registry, Queues
- Relevance-scoping unless the ChatGPT `toolchange` spike has already landed
- `page.addInitScript` / injecting WebMCP into the target origin

---

## 8. Noticed, not fixed

- `apps/workers/browser-mcp/wrangler.toml` documents that
  `[[env.production.kv_namespaces]]` binds a different, older `WARM_SESSIONS`
  namespace than the top-level binding, so `deploy --env production` would
  rebind the wrong one. Both were empty when last checked. Not touched here.
- `browser-mcp` exposes an MCP-shaped REST API (`/tools`, `POST /tools/:name`)
  and speaks no JSON-RPC, so no MCP client can connect to it. Wrapping it in
  `McpAgent` is a separate, useful change and is out of scope for this spec.
- `browser-mcp`'s `workspace-isolation.test.ts` asserts UUID inequality rather
  than refusing a cross-session call. Do not port it as an isolation proof.
