# BrowserMatic

**Every site's own tools. One conversation. Names only.**

Ask an assistant to compare four stores, book dinner and a film, price a trip,
or fill the twentieth council form, and it stalls at the same wall: a site's
agent tools only exist on that site's own page. Four stores means four
conversations.

BrowserMatic is one session that spans origins. Type a web address and we open
it in a browser that installs the WebMCP API **before the site's own code
runs** — so the site registers its own tools, we add none, and we carry them
into your assistant, origin-qualified, across as many sites as you like.

**Live:** <https://browsermatic.dev> — no login, no key, no install.

## Try it in a minute

1. Open the live URL, type `allbirds.com`, press Go.
2. The store's own tools appear as chips: `search_catalog_on_allbirds_com`,
   `update_cart_on_allbirds_com`, and the rest — ten of them, all registered by
   Allbirds' own script.
3. Grant a second store. Both sets sit in one list; the first is untouched.
4. Ask for a checkout fill. It stops and names the exact profile fields before
   any of them leave your machine.

In ChatGPT desktop use **GPT-5.6 Sol or Terra** — Luna has WebMCP disabled and
Enterprise/Edu workspaces have no site tools. Give it the `/s/<token>` URL.

## One session, two views

`/c/<token>` is the **console** — what you open. It holds the profile and is
the only view that can approve a field leaving your machine.

`/s/<token>` is the **façade** — what an agent loads. It registers the tools
and holds no profile.

Both connect at once, which is the normal way to use this: the agent works on
the façade while you watch and approve on the console.

## What is true

Do not write "your data never leaves your device." Injected fields travel
page → Worker → Durable Object → the target origin. A store legitimately learns
a shipping address when checkout is filled.

- The profile is never uploaded wholesale. Only declared paths resolve.
- Values are never logged. The audit table has no value column.
- A tool that draws on the profile cannot run unattended. It suspends until a
  human approves it by name; with no console attached it returns
  `needs-console` rather than filling blanks and reporting success. An agent
  holding the same token cannot answer for you — the façade is never sent the
  request.
- `document.modelContext` is behind a Chrome origin trial and the remote
  browser lacks it. We install the API before the page's own scripts run, so a
  storefront that ships WebMCP can register its own tools. **We add none of our
  own.** Without this, a WebMCP storefront exposes nothing at all.
- Keystrokes in the viewport cross this Worker in plaintext and are not stored.

## Demo origins

| Origin | Kind |
|---|---|
| allbirds.com, brooklinen.com | Shopify native — their tools, proxied |
| kayak.com | Synthesised — hand-written steps |
| gov.uk | Synthesised, profile-gated — postcode only |

Any https origin can be granted. `list_remote_tools` reports its real WebMCP
surface, and observed tools register origin-qualified without a hand-authored
manifest. Sites publishing no tools of their own are the next phase — see
`docs/superpowers/specs/2026-09-04-generated-tools-design.md`.

## Architecture

```
ChatGPT desktop, Claude, or any MCP client
  │  loads /s/<token>            or  speaks JSON-RPC at /mcp
  ▼
Façade page  ──registerTool(…, { signal })──▶ platform discovery
       │  WebSocket (tool_call, approval_request, frame, input)
       ▼
Session Durable Object  ── one per session
   • consent, audit log, approval gate      • CDP screencast + input relay
       │  Browser Rendering
       ▼
Chromium ── Playwright / CDP ──▶ target origin
            WebMCP API installed before the page's own scripts
```

Load-bearing decisions:

- **Imperative `registerTool` on the top-level page.** ChatGPT's browser has no
  declarative form and does not discover tools in iframes.
- **A capability URL, not a login.** ChatGPT will not carry a session cookie.
  High-entropy token in the path, short TTL, revocable, `Referrer-Policy:
  no-referrer`.
- **Origin-qualified names, always** — `search_flights_on_kayak_com`, never
  `search_flights`. ChatGPT's permission model is per-site, so spanning origins
  extends it rather than routing around it.
- **One `AbortController` per tool.** WebMCP has no `unregisterTool` and a
  duplicate name throws, so granting a fourth store never disturbs the first
  three.
- **Automation is the default; the grant click is the option.** Autonomous mode
  is on unless you turn it off. Granting an *origin* is automatic; releasing a
  *profile field* is not.
- **An audit table with no value column.** "We don't log it" is a policy;
  "there is nowhere to log it" is an architecture.
- **Fail-closed SSRF on every navigation**, whoever initiated it. Hostname
  literals and resolved A/AAAA records both checked; a resolver error rejects.
- **No LLM in the hot path.** Tools replay a bound sequence or call the remote
  page's own handler. Execution is deterministic.

## Two surfaces

The façade at `/s/<token>` is what ChatGPT's in-app browser sees. The same
Worker also speaks MCP at `/mcp` — JSON-RPC, bearer token or OAuth 2.1 with
PKCE — verified against the official MCP SDK, so any compliant client drives
the identical session headlessly. See [docs/oauth.md](docs/oauth.md).

## Setup

```bash
pnpm install
pnpm test
pnpm dev
pnpm run deploy   # `pnpm deploy` is pnpm's own workspace command, not this script
```

Browser Rendering must be enabled on the account. One browser per session,
started on the first grant and released when you leave.

No API key is required. The optional in-page chat panel reaches a model through
the Cloudflare `ai` binding; drop that binding and set `OPENAI_API_KEY` to call
directly. Either way the key never reaches the page. ChatGPT drives the
registered tools with no model configured at all.

Façade headers (`public/_headers`): `Origin-Agent-Cluster: ?1`,
`Permissions-Policy: tools=*`, `Referrer-Policy: no-referrer`.

## Limits

- A passkey signs you in to BrowserMatic itself, on your own device. It cannot
  log you in to a *remote site* — that authenticator is on your machine and the
  remote browser runs in Cloudflare's network. Demo remote logins with a
  password or OAuth.
- Selectors in hand-written manifests are bound at authoring time and break
  when a site redesigns.
- Verified against Allbirds and Brooklinen. The `/mcp` surface is proven
  against the MCP SDK; individual MCP clients are listed in
  `tests/MCP_CLIENTS.md`.

Design decisions are recorded in the commit history and in `docs/`.
