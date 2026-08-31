# mcpmatic

A WebMCP session that spans origins.

Shopify storefronts already register `search_catalog`, `update_cart`, and
`proceed_to_checkout`. This page does not reimplement those handlers. It
proxies them, origin-qualified, so an agent that is not on the store can
still call them. Sites with no WebMCP get a synthesised tool. A local
profile fills only the checkout fields the store’s own tools do not
provide.

Architecture below. Design decisions are recorded in the commit history.

## What is true

Do not write “your data never leaves your device.” Injected fields travel
page → Worker → Durable Object → the target origin. The store legitimately
learns a shipping address when checkout is filled.

- The profile is never uploaded wholesale.
- Only declared paths resolve (`fillsFrom: ["address.postcode"]` is that key).
- Values are never logged. The audit table has no value column.
- Native WebMCP on the remote page is preferred over click replay.
- Keystrokes in the viewport cross this worker in plaintext and are not stored.

ChatGPT’s site tools are per page. A store’s tools live on that store. One
conversation that shops a merchant and uses a site without WebMCP needs a
session page. That is this.

## Demo origins

| Origin | Kind | Tools |
|---|---|---|
| [allbirds.com](https://www.allbirds.com) | Shopify native | `search_catalog_on_allbirds_com`, `update_cart_on_allbirds_com`, `proceed_to_checkout_on_allbirds_com`, `fill_checkout_on_allbirds_com` |
| [brooklinen.com](https://www.brooklinen.com) | Shopify native | same pack, `_on_brooklinen_com` |
| [kayak.com](https://www.kayak.com) | Synthesised | `search_flights_on_kayak_com` |

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
- **Consent gates registration, not just the chat panel.** ChatGPT's permission
  model is per-site; a façade that fans out to arbitrary origins would route
  around it. So: origin-qualified names (`search_flights_on_kayak_com`, never
  `search_flights`), and no `registerTool` for an origin until the human grants
  it. The permission model is extended to sites that cannot declare tools yet,
  not bypassed.
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
