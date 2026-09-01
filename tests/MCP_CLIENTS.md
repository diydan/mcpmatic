# MCP Client Test Matrix

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

(populated by the engineer running the manual tests)

## Decision matrix

| Outcome | What it means | What we ship |
|---|---|---|
| Both clients do full OAuth | Plan was correct | OAuth 2.0 + PKCE in Phase 1.5 |
| Claude OAuth, ChatGPT static tokens only | Spec-compliance is fine; ChatGPT's client is the constraint | Static token path for ChatGPT; OAuth for everyone else; both on the same backend |
| Neither does OAuth | MCP support is incomplete in both clients | Hold MCP surface; ship when clients catch up |
