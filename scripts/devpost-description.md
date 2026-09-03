# WebMCP Challenge — Devpost entry text for BrowserMatic

## Project name
BrowserMatic

## Tagline
Cross-origin WebMCP. One conversation. Names only.

---

## Project story (paste into "Please describe your project")

Your AI agent is becoming a customer of the open web. Just as mobile-friendly sites won the last decade, AI-callable sites will win this one. BrowserMatic is the session page that holds your consent and lets one agent shop, fill, and book across any site using each site's own WebMCP tools on your behalf.

**Why this is a strong fit for WebMCP**

WebMCP is how a site declares what an agent may do. Shopify Liquid storefronts already register `search_catalog`, `update_cart`, and `proceed_to_checkout`. We do not reimplement those handlers. We proxy them, origin-qualified, so ChatGPT — which only sees tools on the page it loaded — can still call them. Sites with no WebMCP get a synthesised tool. Observed tools on the open page are registered the same way.

The permission model is ChatGPT's: tools are granted to a page. A façade that silently reached into other origins would route around that. So:

- No `registerTool` for an origin until the human grants it.
- Names are origin-qualified (`search_catalog_on_allbirds_com`, never `search_catalog`).
- Consent gates registration, not just the chat panel.

WebMCP is the load-bearing API, not a badge. Abort the registration signal and both ChatGPT and the in-page agent have no tools.

**What is better for the user**

One conversation, many origins. Grant Allbirds and the store's own catalog tool appears. Grant Kayak in the same session and a synthesised flight search appears next to it. The human watches the remote page in a live viewport, blesses any profile fields before they leave the device, and can take the keyboard at any moment.

The profile is never uploaded wholesale. Only declared paths resolve (`fillsFrom: ["address.postcode"]` is that key). The audit table has no value column — names, origin, timestamp. "We don't log it" is a policy; "there is nowhere to log it" is the architecture.

**What people and agents can do together that was hard before**

Before, an agent on a ChatGPT site could only call tools that page registered. Shopping a merchant and then a site without WebMCP meant two conversations, or an agent guessing at clicks.

Now, on one façade page:

1. Open https://mcpmatic.dan-3c7.workers.dev, type `allbirds.com`, Go.
2. Allbirds is pre-granted. `search_catalog_on_allbirds_com` is a real `document.modelContext.registerTool` on the page ChatGPT loaded.
3. Ask: "Search Allbirds for wool runners." The execute handler proxies into the storefront's own `search_catalog`. Real catalog results: Men's and Women's Wool Runners at $110, availability included.
4. Grant Brooklinen. `search_catalog_on_brooklinen_com` joins the same tool list. Allbirds tools stay registered — one AbortController per tool, so granting a second origin cannot wipe the first.
5. `fill_checkout_on_allbirds_com` asks the human to bless name and address fields before they cross the Worker. Payment is never submitted.

Five years from now every site will have WebMCP. BrowserMatic is what that future looks like from the user side: one chat, many sites, each site owning its own tools. The video above is the demo.

People grant origins and bless fields. Agents call structured tools. The store still owns its handlers. That is WebMCP spanning the open web, not replacing it.

**How we implemented WebMCP**

Imperative `registerTool` on the top-level façade. ChatGPT's in-app browser does not support the declarative form and does not discover tools registered in iframes, so `toolname` on a form is not a site tool and an iframe surface would be invisible.

```ts
await document.modelContext.registerTool(
  {
    name: spec.name,          // e.g. search_catalog_on_allbirds_com
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: wrap(spec),      // bless → WebSocket → Durable Object → remote page
  },
  { signal: ac.signal },      // one AbortController per tool
);
```

That is `src/lib/register-all.ts`. The façade holds no browser state. A tool call is: façade `execute` → WebSocket → Session Durable Object → Cloudflare Browser Rendering Chromium on the target origin → result back the same way.

The remote Chromium does not ship `document.modelContext` (it is a Chrome origin-trial API). A Shopify storefront that ships WebMCP only *reads* the API and registers nothing when it is missing. Before the store's scripts run, we install the API into the remote page — no tools of our own, just the platform capability the site's code already targets. Allbirds then registers its tools, and we call them. `list_remote_tools` reports what the open page actually exposed.

Execution is deterministic. There is no LLM in the tool path. Native WebMCP on the remote page is preferred over click replay. Fail-closed SSRF (hostname and resolved A/AAAA) on every navigation, whoever initiated it.

The same Worker also speaks MCP at `/mcp` (bearer session token, plus OAuth 2.1 with PKCE S256) so Claude or any MCP client can drive the same session. The WebMCP surface is the one ChatGPT's in-app browser sees.

**Built during the challenge**

First commit 2026-08-31. MIT licensed. Hosted on Cloudflare Workers. Live URL, public repo, and video freeze after the deadline.

---

## What is next (paste into "What is next")

Beyond the user session, the same primitives enable a developer platform: hosted WebMCP tool registration, call analytics, error tracking, and a public directory of agent-callable sites. Today, merchants self-host their `registerTool` scripts; tomorrow, BrowserMatic can host, observe, and certify them. The architecture that makes a user's audit row cannot store a value is the same architecture that makes a site's tool surface auditable from the outside.

---

## Testing instructions (paste into credentials / "how to test")

Live URL: https://mcpmatic.dan-3c7.workers.dev
No login, no key, no install.

(The Worker hostname predates the name. It is the right URL.)

PREFERRED — ChatGPT desktop
1. Use GPT-5.6 Sol or Terra. Luna has WebMCP disabled. Enterprise/Edu
   workspaces have no site tools.
2. Open https://mcpmatic.dan-3c7.workers.dev in the in-app browser.
3. Type https://www.allbirds.com and click Go.
4. You land on /c/<token> — the console — with Allbirds already
   granted. The chips search_catalog_on_allbirds_com,
   update_cart_on_allbirds_com, proceed_to_checkout_on_allbirds_com,
   fill_checkout_on_allbirds_com should appear.

   One session has two views. /c/<token> is the console, which a human
   opens: it holds the profile and is the only view that can approve a
   field leaving your machine. /s/<token> is the façade, which an agent
   loads; it registers the same tools and holds no profile. Both work
   in ChatGPT's in-app browser.
5. Ask: "Search Allbirds for wool runners."
   ChatGPT should call search_catalog_on_allbirds_com. The in-page
   panel will also show the call. Expect real catalog results.
6. Click grant on Kayak. search_flights_on_kayak_com appears next to
   the Allbirds tools.
7. Optional: ask to fill checkout. A bless dialog lists the profile
   field names (not values). Deny or Bless. Payment is never submitted.
   Driving /mcp instead, with no console open, returns "needs-console"
   rather than filling blanks and claiming success — that is deliberate,
   not a broken tool.

FALLBACK — Chrome
chrome://flags/#enable-webmcp-testing → enable → restart.
Same URL, same steps. The in-page agent (left panel) calls
document.modelContext.getTools / executeTool even if ChatGPT site
tools are unavailable.

Do not use a passkey login in the remote viewport — the authenticator
is on your device, the login runs in Cloudflare's network.

SSRF: http://127.0.0.1 and private ranges are rejected. That is
intentional.

---

## Built with (paste into "Built with")

WebMCP, Cloudflare Workers, Cloudflare Durable Objects, Cloudflare Browser Rendering, Cloudflare AI Gateway, React, TypeScript, Vite, Playwright, Shopify WebMCP, MCP, OAuth 2.1

---

## Video plan (<3 min, public on YouTube)

Clip 1 — 0:00–0:30. Home page → Allbirds session. Voice: "Your AI agent is becoming a customer of the open web." Cut.
Clip 2 — 0:30–1:00. Grant Brooklinen. Both stores' chips in one list. Voice: "One conversation, many origins, each site owns its tools."
Clip 3 — 1:00–1:45. One message, two stores. "Find wool runners in size 9 on both stores." Cut to results.
Clip 4 — 1:45–2:15. Audit row close-up. Hold on the row. Cursor off the row to show what is not there: no value column.
Clip 5 — 2:15–2:45. Close. "BrowserMatic: cross-origin WebMCP, one conversation, names only."

Total: 2:45. Audio covers everything on screen. No music. No title card.

---

## Gallery (use these, in order, on Devpost)

1. Home page (this session's first screenshot — the dark theme card grid).
2. Session after Allbirds grant — chips, viewport, audit row.
3. Same session after granting Brooklinen — both stores' chips, dual origin.
4. GOV.UK bless dialog (this session's screenshot).
5. Audit row close-up.

Do NOT upload the Playwright QA shots in scripts/qa-screenshots/. They were taken without Browser Rendering and say "no browser binding."

Dismiss Allbirds' "Where are we shipping to?" modal before any screenshot.
