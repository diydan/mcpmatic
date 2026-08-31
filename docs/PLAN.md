# Implementation plan

Companion to [`SPEC.md`](./SPEC.md). How the system is built. Product thesis
and security constraints live in the spec; this file is the work plan.

---

## What we are building

A public HTTPS page that registers WebMCP tools and executes them against a
remote browser.

- Left: chat panel. Right: live viewport.
- The chat agent is a WebMCP **consumer**: `getTools()` / `executeTool()` only.
  `registerAll()` is the only path from a manifest to `registerTool`.
- OpenAI runs in the Durable Object. The key never reaches the page.
- Shopify Liquid storefronts already register `search_catalog`, `update_cart`,
  and `proceed_to_checkout`. Call those on the remote page. Do not replay
  clicks as if the store had no tools. `fill_checkout` covers shipping fields
  those tools do not provide, from a local profile, at call time.
- Origins without WebMCP (Kayak) get a synthesised tool executed over CDP.

Demo origins are listed in `shared/stores.ts`.

---

## Stack

React + Vite + Cloudflare Worker, one Durable Object per `sessionToken`,
Browser Rendering (`recording: false`), WebSocket hibernation.

Required façade headers:

```
Origin-Agent-Cluster: ?1
Permissions-Policy: tools=*
Referrer-Policy: no-referrer
```

---

## Path

```
Browser ── GET /s/<sessionToken>
  registerAll() ── document.modelContext.registerTool(…, { signal })
       ├─ ChatGPT (platform discovery)
       └─ in-page panel (getTools / executeTool)
              │  WebSocket
              ▼
         Session DO  ── OpenAI turn, CDP, audit {origin, tool, fieldNames[], timestamp}
              │
              ▼
         Chromium
              ├─ Shopify: executeTool on the store's own modelContext
              └─ other: Playwright / CDP
```

Never await a later WebSocket message inside `webSocketMessage`. Agent turns
resume when `tool_exec` arrives.

While `execute()` is in flight, drop human input on the canvas (agent driving).
Do not replay buffered events onto a different page.

---

## Security

- Capability URL: high-entropy `sessionToken` in the path, short TTL, not in
  a query string. `Referrer-Policy: no-referrer`.
- Consent before `registerTool` for an origin.
- Bless + `fillsFrom` inside `execute()`, at call time. No whole-profile getter.
- Audit schema has no column for argument values or keystrokes.
- Input events never logged, never stored, never `console`.
- SSRF: `is-private-url` + DoH, fail-closed, on `navigate_to` and human-typed URLs.
- Passkeys cannot work. State that.

---

## Files

```
worker/          Worker + Session DO
src/             React SPA
shared/          protocol, coords, profile, stores
src/lib/register-all.ts
public/_headers
```

No injection of WebMCP into the target origin. ChatGPT loaded this page, not
the store.

---

## Verification

- `getTools` / `executeTool` is the only in-page invocation path. Aborting
  registration leaves the panel empty.
- Duplicate `registerTool` name throws until the previous signal is aborted.
- `fillsFrom: ["address.postcode"]` resolves that key only.
- An audit row has field names, not values. An `input` message writes nothing.
- Private / rebinding navigations are refused.
- Coordinate mapping covers letterboxing.

Manual: grant Allbirds, search catalog, bless checkout fields, grant Kayak,
confirm both tool kinds in one list. Repeat the URL in ChatGPT desktop
(GPT-5.6 Sol or Terra).
