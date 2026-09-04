# Connecting MCP clients

Tests below are run by hand against real MCP-capable clients. Each row in the
decision matrix at the bottom determines the next phase of work.

## How to run a manual test

1. Deploy the Worker: `pnpm run deploy`
2. Create a session token: `curl -X POST https://<host>/sessions`
3. In the client, add an MCP server:
   - URL: `https://<host>/mcp`
   - Auth: Bearer `<session-token>`
4. Verify the client shows the three SPINE tools (`get_page_state`,
   `list_available_origins`, `navigate_to`).
5. Try to call a per-origin tool that hasn't been granted — should NOT be
   visible in the tool list.
6. Grant an origin via `POST /s/<token>/consent` with `{"origin": "https://www.kayak.com"}` and re-fetch the tool list — should now include `search_flights_on_kayak_com`.

## What to log per client

For each client below, capture and paste into the Findings section:

1. **First request behavior.** Did the client include an Authorization header
   on the first try, or did it rely on the 401 challenge?
2. **The 401.** Did the client honor `WWW-Authenticate` and retry with auth?
3. **Dynamic client registration.** Did the client send `client_id`?
   Pre-registered or self-registered?
4. **Redirect URI.** What redirect URI did the client use?
5. **Refresh behavior.** After invalidating the access token, did the client
   refresh or bounce to login?
6. **Error surfacing.** When something fails, what does the user see?

## Clients to test

### Claude desktop (spec-compliant reference client)

Expected: Full handshake, all SPINE tools visible, per-origin tools visible
after consent.

### ChatGPT (the empirical question)

Unknown. Test against the latest ChatGPT desktop build with MCP support
enabled. If ChatGPT only supports static bearer tokens pasted into a config
field, document this clearly — it determines the auth design.

## Findings

(populated by the OAuth work — further manual testing against real
Claude Desktop and ChatGPT builds still pending a deployed Worker URL)

### Wire-format compatibility

`tests/oauth-e2e-sdk.test.ts` drives the real
`@modelcontextprotocol/sdk` (1.30+) through the full OAuth flow —
register → authorize → token → SDK `connect()` → `serverInfo.name === "browsermatic"`.
The SDK's `client.connect()` succeeds without modifying either side, which
proves the OAuth surface works against any spec-compliant MCP client.

### Auth at `/mcp`

Two bearer shapes work:

- **64 hex chars** (case-insensitive) — session token, pass-through
  to the SessionDO. No I/O in the bridge for this branch.
- **43 base64url chars** — OAuth access token, resolved via
  `worker/oauth/mcp-bridge.ts` → `OAUTH_TOKENS.get("token:<access_token>")`
  → `userSessionToken` → SessionDO.

Unknown bearer → 401. Expired bearer → 401 (KV's `expirationTtl` is the
primary enforcement; the payload's `expiresAt` is a second-line defense).

### Bearer test outcomes

- **First request behavior.** The SDK-driven test confirms the SDK sends
  `Authorization: Bearer <access_token>` on the first `/mcp` call (after
  acquiring it via `/oauth/token`). The transport merges
  `requestInit.headers` into every request via `_commonHeaders()`.

- **The 401.** The bridge returns an identical 401 shape for "unknown
  bearer" and "malformed bearer" — no information leak about which token
  shapes were tried. The SDK's transport wraps the 401 in a
  `StreamableHTTPError` and `client.connect()` rejects before it ever
  sees an `initialize` result.

- **Dynamic client registration.** `tests/oauth-e2e.test.ts` step 2
  confirms `/oauth/register` issues a `clientId` (UUID v4) + `clientSecret`
  (32 random bytes, base64url). RFC 7591-compliant; `redirect_uris` are
  SSRF-checked at registration time.

- **Redirect URI.** Brief-mandated exact-string match — the registered
  `redirect_uri` must equal the one on the token-exchange call byte for
  byte. Real-world clients that need query-string variants must register
  each variant as a separate `redirect_uri`.

- **Refresh behavior.** `tests/oauth-e2e.test.ts`'s refresh-rotation test
  confirms a new access + refresh pair is minted and the old refresh key
  is deleted from KV. A second use of the old refresh token returns
  `400 invalid_grant` because KV.get on the deleted key returns null.

- **Error surfacing.** 400/401 JSON error responses follow RFC 6749 §5.2
  shape (`{error, error_description}`). The consent form's HTML uses POST
  + `Referrer-Policy: no-referrer` + `Cache-Control: no-store`, so the
  session token never leaks via `Referer`, browser history, or
  intermediary caches.

### Real Claude Desktop / ChatGPT testing

Still pending — requires a deployed Worker URL. The
`tests/oauth-smoke.sh` script is the post-deploy manual procedure; the
engineer should run it against `https://browsermatic.dev`
after the OAuth deploy (which requires
`wrangler kv namespace create OAUTH_TOKENS` first to replace the
`"to-be-created"` placeholder id in `wrangler.jsonc`).

### Latent bugs in `worker/mcp/server.ts` fixed in Task 10

The SDK-driven e2e flushed out two real bugs that the hand-rolled tests
(which used `id: 1`) missed. Both would have blocked every compliant MCP
client:

1. `new Response("", { status: 204 })` → `new Response(null, { status: 204 })`.
   Per RFC 9110 §6.4.1 a 204 response MUST NOT include a body. Cloudflare's
   runtime accepted the empty string; Node did not, and every MCP
   notification round-trip failed.
2. `if (!parsed.req.id)` → `if (parsed.req.id === undefined)`. The MCP SDK
   uses integer ids starting at 0 for the first request; `!0` is `true`,
   so every real `initialize` was misrouted to the notification path.
   No compliant MCP client could ever have talked to the Worker.

## Decision matrix

| Outcome | What it means | What we ship |
|---|---|---|
| Both clients do full OAuth | Plan was correct | OAuth 2.0 + PKCE |
| Claude OAuth, ChatGPT static tokens only | Spec-compliance is fine; ChatGPT's client is the constraint | Static token path for ChatGPT; OAuth for everyone else; both on the same backend |
| Neither does OAuth | MCP support is incomplete in both clients | Hold MCP surface; ship when clients catch up |
