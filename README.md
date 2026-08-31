# mcpmatic

A WebMCP session that spans origins.

Shopify storefronts already register `search_catalog`, `update_cart`, and
`proceed_to_checkout`. This page does not reimplement those handlers. It
proxies them, origin-qualified, so an agent that is not on the store can
still call them. Sites with no WebMCP get a synthesised tool. A local
profile fills only the checkout fields the store’s own tools do not
provide.

Architecture: [`docs/SPEC.md`](docs/SPEC.md). Work plan: [`docs/PLAN.md`](docs/PLAN.md).

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
