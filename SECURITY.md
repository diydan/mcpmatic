# Security

## Reporting a vulnerability

Please report security issues privately. Email `security@browsermatic.dev` with a description and reproduction steps. Expect an acknowledgement within 72 hours.

## Scope

BrowserMatic is a Cloudflare Worker that proxies WebMCP tools across origins on behalf of a human user. In-scope issues include:

- Auth bypass on `/mcp`, `/oauth/*`, `/account/*`, or `/sessions/*`.
- SSRF or DNS-rebind via the navigation tools.
- Audit-log leaks (the table is names-only by design; leaks of the value column would be a finding).
- OAuth implementation errors (PKCE, redirect_uri validation, code reuse, refresh-token rotation).
- Injection via tool arguments or hosted form fields.

## Out of scope

- The remote origins themselves (e.g. a vulnerability on `allbirds.com` is not ours).
- Denial of service against the live deployment (rate limits are best-effort).
- Browser Rendering session security beyond what this Worker controls.
