<!-- Moved out of README.md: reference material, not an introduction. -->

# OAuth 2.1 at `/mcp`

Two bearer shapes are accepted at `/mcp`. The original — a high-entropy
64-hex session token that ChatGPT and Claude paste into their MCP server
config — still works exactly as it did. A spec-compliant OAuth 2.1 surface
sits alongside it so any compliant MCP client can register itself, drive a
hosted consent page, and acquire its own access token. Both shapes are
accepted at `/mcp`; nothing existing breaks.

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

1. **64 hex chars** (case-insensitive) — session token. Pass-through
   to the SessionDO. No KV lookup; the bearer IS the session.
2. **43 base64url chars** — OAuth access token. Resolved via
   `OAUTH_TOKENS.get("token:<access_token>")`. The stored payload carries
   the original `userSessionToken`, which is what `/mcp` hands to the
   SessionDO. `expiresAt` is a second-line defense on top of KV's
   `expirationTtl`; either one rejecting it means 401.
3. **Anything else** — 401 with no information leak about which shapes were
   tried.

This is what lets a single Worker URL (`https://<host>/mcp`) work for both
"paste a session token" clients and full OAuth clients without any
per-deployment config.

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

