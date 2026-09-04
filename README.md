# BrowserMatic

A WebMCP session that spans origins.

Shopify storefronts already register `search_catalog`, `update_cart`, and
`proceed_to_checkout`. This page does not reimplement those handlers. It
proxies them, origin-qualified, so ChatGPT — which only sees tools on the
page it loaded — can still call them. Sites with no WebMCP get a synthesised
tool. Observed tools on the open page are registered the same way. A local
profile fills only the fields a tool named, after the human approves them.

**Live:** <https://mcpmatic.dan-3c7.workers.dev> — open it, grant an origin,
and the tools appear. No login, no key, no install.

One session, two views. `/c/<token>` is the **console** — what you open. It
holds the profile, and it is the only view that can approve a field leaving
your machine. `/s/<token>` is the **façade** — what an agent loads; it
registers the tools and holds no profile. Both can be connected at once, which
is the normal way to use this: the agent works on the façade while you watch
and approve on the console.

In ChatGPT desktop use **GPT-5.6 Sol or Terra**: Luna has WebMCP disabled, and
Enterprise/Edu workspaces have no site tools. Give it the `/s/<token>` URL and
grant the origin in that view.

Architecture below. Design decisions are recorded in the commit history.

## What is true

Do not write “your data never leaves your device.” Injected fields travel
page → Worker → Durable Object → the target origin. The store legitimately
learns a shipping address when checkout is filled.

- The profile is never uploaded wholesale.
- Only declared paths resolve (`fillsFrom: ["address.postcode"]` is that key).
- Values are never logged. The audit table has no value column.
- Native WebMCP on the remote page is preferred over click replay.
- A tool that draws on the profile cannot run unattended. It suspends until a
  human approves it on the console, naming the exact fields; with no console
  attached it returns `needs-console` rather than filling blanks and reporting
  success. An agent holding the same token cannot answer for you — the façade
  is not sent the request.
- `document.modelContext` is a browser API behind a Chrome origin trial, and the
  remote browser does not have it. This session installs the API into the remote
  page before the page's own scripts run, so a storefront that ships WebMCP can
  register its own tools. We add no tools of our own there — Allbirds registers
  ten, and we call them. Without this, a WebMCP storefront exposes nothing at
  all in a browser without the trial.
- Keystrokes in the viewport cross this worker in plaintext and are not stored.

ChatGPT’s site tools are per page. A store’s tools live on that store. One
conversation that shops a merchant and uses a site without WebMCP needs a
session page. That is this.

## Demo origins

| Origin | Kind | Tools |
|---|---|---|
| [allbirds.com](https://www.allbirds.com) | Shopify native | `search_catalog_on_allbirds_com`, `update_cart_on_allbirds_com`, `proceed_to_checkout_on_allbirds_com`, `fill_checkout_on_allbirds_com`, plus whatever else the store registers, observed live |
| [brooklinen.com](https://www.brooklinen.com) | Shopify native | same pack, `_on_brooklinen_com` |
| [kayak.com](https://www.kayak.com) | Synthesised | `search_flights_on_kayak_com` |
| [gov.uk](https://www.gov.uk/find-local-council) | Synthesised + approve | `find_local_council_on_gov_uk` (postcode only) |

You browse the remote page; ChatGPT calls the tools on this façade. Grant any
https origin — `list_remote_tools` reports its real WebMCP surface, and
`call_remote_tool` plus origin-qualified `registerTool` make those tools
callable from ChatGPT without a hand-authored manifest.

The hosted UI's header accepts any URL, not just these four. On the home
page it initializes a session pre-granted for the chosen origin by POSTing
`{ origin }` to `/sessions`; on the session page the same input drives the
existing `navigate_to` tool to point the live browser at any URL. The server
is the policy layer — URL parse, `https:` protocol, and the fail-closed
`isPrivateUrl` SSRF guard run on every accept, and the client does no
validation of its own.

## Architecture

```
Browser (ChatGPT desktop, or any browser + polyfill)
  │  loads https://<host>/s/<sessionToken>
  ▼
Façade page
  registerAll() ──▶ document.modelContext.registerTool(…, { signal })
       │
       ├─ ChatGPT browser agent  (platform discovery)
       └─ in-page chat panel     (getTools / executeTool)
              │  WebSocket  (chat, tool_call, tool_result, frame, input)
              ▼
         Session Durable Object  (one per session)
           • model turn, server-side only
           • CDP session, screencast, input relay
           • audit log in DO SQLite
              │  Browser Rendering binding
              ▼
         Chromium  ── Playwright / CDP ──▶ target origin
                      (real cookies, real CSP; no WebMCP injection)
```

A tool call travels façade `execute` handler → WebSocket → DO → the remote
page, and the result returns the same way. The façade page holds no browser
state. Tools are registered on the **façade** document ChatGPT loaded, never
injected into the target origin.

Choices worth stating, because they are the load-bearing ones:

- **Imperative `registerTool` on the top-level page.** ChatGPT's built-in
  browser does not support the declarative form and does not discover tools
  registered in iframes, so `toolname` on a form is not a site tool and an
  iframe surface would be invisible.
- **A capability URL, not a login.** ChatGPT must be able to load the page and
  will not carry a session cookie. A high-entropy token in the path, short TTL,
  one active browser binding, revocable by `DELETE`. Never in a query string,
  and the response sends `Referrer-Policy: no-referrer`.
- **Origin-qualified names, always.** ChatGPT's permission model is per-site,
  so a tool is `search_flights_on_kayak_com`, never `search_flights`. A name
  says which origin it reaches, on every surface.
- **Automation is the default; the grant click is the option.** Autonomous mode
  is on unless a human turns it off: every demo origin is granted, and a site
  you or the agent opens is granted as it opens. Turn it off and no
  `registerTool` happens for an origin until you grant it, one at a time. The
  switch is in the console and the choice survives reloads.

  These are two different consents and only one of them moved. Granting an
  *origin* is now automatic. Releasing a *profile field* is not: a tool that
  draws on your name or address still suspends until you approve it by name,
  and with no console attached it refuses rather than filling blanks.
- **An audit table with no value column.** Rows are `{origin, tool,
  fieldNames[], timestamp}`. "We don't log it" is a policy; "there is nowhere to
  log it" is an architecture.
- **Fail-closed SSRF on every navigation**, whoever initiated it — the tool or
  the human. Hostname literals and resolved A/AAAA records are both checked, and
  a resolver error rejects.
- **No LLM in the hot path.** Tools replay a bound action sequence, or call the
  remote page's own WebMCP handler. Execution is deterministic.

There is no `unregisterTool()` in WebMCP, and a second `registerTool` with the
same name rejects with `InvalidStateError`. So each tool holds its own
`AbortController` and a newly granted origin adds only its own tools; already
registered ones are never aborted and re-registered.

## WebMCP is load-bearing

```
manifest ── registerAll() ── document.modelContext.registerTool(…, { signal })
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
         ChatGPT (platform discovery)         in-page panel
                                              getTools() / executeTool()
                                                    │
                                                    ▼
                                              remote page
                                              Shopify: that page's executeTool
                                              otherwise: CDP
```

Abort the registration signal and the in-page agent has no tools
(`tests/webmcp.test.ts`).

## Setup

```bash
pnpm install
pnpm test
pnpm dev
pnpm run deploy   # `pnpm deploy` is pnpm’s own workspace command, not this script
```

There is no API key to set. The in-page agent reaches an OpenAI model through
the Cloudflare `ai` binding and AI Gateway Unified Billing — Cloudflare holds
the provider credentials, so no key is stored in this Worker or typed on a
command line. It needs prepaid AI Gateway credits on the account.

If you would rather call OpenAI directly, drop the `ai` binding from
`wrangler.jsonc` and set the key instead; `runTurn` takes that path when there
is no binding. Either way the key never reaches the page.

```bash
npx wrangler secret put OPENAI_API_KEY   # fallback path only
```

`OPENAI_MODEL` picks the model (`openai/gpt-5.5` by default; a bare
`gpt-5.5` also works). See `.dev.vars.example` for the optional settings.

ChatGPT desktop: GPT-5.6 Sol or Terra (Luna has WebMCP disabled). Same
`/s/<token>` URL. ChatGPT calls the registered tools with no model
configured at all — the spine does not depend on this.

Browser Rendering must be enabled on the account. Sessions launch with
`recording: false`. One browser per session, started on your first grant and
released when you leave.

Passkeys cannot work here: the authenticator lives on your device, and the
login happens in a browser running in Cloudflare's network. Demo on a
password or OAuth login.

Façade headers (`public/_headers`):

```
Origin-Agent-Cluster: ?1
Permissions-Policy: tools=*
Referrer-Policy: no-referrer
```

## Phase 1.5: OAuth

Phase 1 shipped bearer-token auth at `/mcp` — a high-entropy 64-hex session
token that ChatGPT and Claude paste into their MCP server config. Phase 1.5
adds a spec-compliant OAuth 2.1 surface so any compliant MCP client can
register itself, drive a hosted consent page, and acquire its own access
token. Both shapes are accepted at `/mcp`; nothing existing breaks.

### Routes

| Route | Method | Spec | Purpose |
|---|---|---|---|
| `/oauth/register` | `POST` | [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) | Dynamic client registration. Body `{redirect_uris, client_name?}`. Returns `{clientId, clientSecret}`. `redirect_uris` are SSRF-checked at registration time; private URLs fail-closed. |
| `/oauth/authorize` | `GET`, `POST` | [RFC 6749 §4.1.1](https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.1) | Hosted consent UI. `GET` renders the page; `POST` with `consent=approve\|deny` + `session_token` issues the auth code and 302s to the client's `redirect_uri?code=...&state=...`. |
| `/oauth/token` | `POST` | [RFC 6749 §4.1.3](https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.3) | Token endpoint. `grant_type=authorization_code` mints a fresh access + refresh pair; `grant_type=refresh_token` rotates. Errors follow RFC 6749 §5.2 shape (`{error, error_description}`). |
| `/mcp` | `POST` | [RFC 6749 §7](https://datatracker.ietf.org/doc/html/rfc6749#section-7) | Unchanged. Now accepts two bearer shapes — see below. |

### Two bearer shapes at `/mcp`

`worker/oauth/mcp-bridge.ts` resolves the bearer before the JSON-RPC handler
sees the request. Disambiguation is by length and charset, not by a
`WWW-Authenticate` round-trip:

1. **64 hex chars** (case-insensitive) — Phase 1 session token. Pass-through
   to the SessionDO. No KV lookup; the bearer IS the session.
2. **43 base64url chars** — Phase 1.5 OAuth access token. Resolved via
   `OAUTH_TOKENS.get("token:<access_token>")`. The stored payload carries
   the original `userSessionToken`, which is what `/mcp` hands to the
   SessionDO. `expiresAt` is a second-line defense on top of KV's
   `expirationTtl`; either one rejecting it means 401.
3. **Anything else** — 401 with no information leak about which shapes were
   tried.

This is what lets a single Worker URL (`https://<host>/mcp`) work for both
the Phase 1 "paste a session token" clients and Phase 1.5's full OAuth
clients without any per-deployment config.

### PKCE S256 is mandatory

Per [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636), every
authorization-code request MUST include `code_challenge_method=S256`.
`plain` is rejected at `/oauth/authorize` with
`{"error":"invalid_request","error_description":"PKCE S256 required"}`.
`verifyPkce` enforces the RFC 7636 §4.6 verifier length/charset rules
(43–128 chars from `[A-Za-z0-9-._~]`) before hashing and uses a
constant-time compare on the digest.

### Hosted consent flow

The consent page lives at the Worker, not at a separate origin. This keeps
session tokens inside the same security perimeter as the session they bind.

1. Client redirects the user to `GET /oauth/authorize?response_type=code&client_id=...&redirect_uri=...&state=...&code_challenge=...&code_challenge_method=S256`.
2. The Worker renders an HTML form. The `session_token` is **not** in the
   URL — the user pastes it into the form. The page sends
   `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, so the
   token never lands in `Referer` headers, browser history, or intermediary
   caches.
3. On `POST /oauth/authorize`, the form's `consent` field carries either
   `approve` or `deny`. The Worker verifies the `session_token` against the
   SessionDO sentinel row before binding it to an auth code — a random
   pasted string mints no code.
4. On approve, the Worker mints a 32-byte `code`, persists it as an
   `OAuthCodeDO` with a 10-minute TTL, and 302s to
   `redirect_uri?code=...&state=...`. On deny, it 302s with
   `error=access_denied&state=...`.

### SDK usage

Driving the full OAuth flow + first MCP call from
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
is six lines of real work:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from
  "@modelcontextprotocol/sdk/client/streamableHttp.js";

// 1. Register a client (RFC 7591). Returns { clientId, clientSecret }.
const reg = await fetch(`${WORKER}/oauth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ redirect_uris: ["https://example.com/cb"] }),
}).then(r => r.json());

// 2. Build a PKCE S256 verifier + challenge (RFC 7636).
const verifier = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
const challenge = base64urlNoPad(new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
));

// 3. Direct the user to /oauth/authorize?…&code_challenge=<challenge>&code_challenge_method=S256
//    The hosted consent page POSTs back with the session_token; the Worker
//    redirects to redirect_uri?code=...&state=... . Capture the code.

// 4. Exchange code → tokens.
const tok = await fetch(`${WORKER}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code, redirect_uri: "https://example.com/cb",
    code_verifier: verifier,
    client_id: reg.clientId, client_secret: reg.clientSecret,
  }),
}).then(r => r.json());

// 5. Connect.
const transport = new StreamableHTTPClientTransport(new URL(`${WORKER}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
});
const client = new Client({ name: "demo", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
```

The same SDK is what ships in Claude Desktop and ChatGPT's MCP integrations,
so anything the SDK accepts is what those clients accept.

### Tests

- `tests/oauth-e2e.test.ts` — in-process integration walk
  (register → authorize → token → /mcp) with direct handler calls. Covers
  refresh-token rotation, code single-use, forged-`session_token`
  rejection.
- `tests/oauth-e2e-sdk.test.ts` — same flow, but the final `/mcp`
  handshake is driven by the real `@modelcontextprotocol/sdk` `Client` +
  `StreamableHTTPClientTransport`. Asserts `serverInfo.name === "browsermatic"`.
  This is wire-format compatibility proof.
- `tests/oauth-smoke.sh` — manual post-deploy procedure. Run after
  `pnpm exec wrangler deploy` (which requires
  `wrangler kv namespace create OAUTH_TOKENS` first to replace the
  `"to-be-created"` placeholder id) against the live Worker URL.
- `tests/worker-routes.test.ts` — route-wiring guard. Confirms
  `worker/index.ts` dispatches `/oauth/register`, `/oauth/authorize`,
  `/oauth/token` to the correct handlers.
