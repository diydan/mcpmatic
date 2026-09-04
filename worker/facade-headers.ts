/**
 * Security headers spread onto every response this worker returns to a
 * browser. Kept in its own tiny module so it can be imported from
 * `worker/index.ts` AND from `worker/oauth/authorize.ts` without dragging
 * in `cloudflare:workers` (the test environment runs under Node and can't
 * resolve that runtime import).
 *
 * `Referrer-Policy: no-referrer` matters for /oauth/authorize because the
 * session_token that becomes the /mcp bearer flows through the URL —
 * keeping the `Referer` empty means a token that lands on an external
 * redirect target doesn't leak back via the next navigation.
 *
 * `X-Frame-Options: DENY` and `frame-ancestors 'none'` (in the CSP) keep
 * the SPA out of every framing surface — the audit (§1.5) flagged their
 * absence as a public-readiness gap.
 *
 * The rationale for each CSP directive lives as a comment on the literal
 * below — see the `Content-Security-Policy` entry for the source of truth.
 */
export const FACADE_HEADERS: Record<string, string> = {
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "tools=*",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  // Content-Security-Policy: per the 2026-09-04 review (M5). `'self'` for
  // scripts and styles; `'wasm-unsafe-eval'` for the WASM that Vite ships
  // for the in-browser agent; `connect-src 'self' wss:` so the bridge
  // socket works; `img-src https: data:` because the screencast is data:
  // and tool thumbnails use https; `frame-ancestors 'none'` to defeat
  // clickjacking. No `'unsafe-inline'` *anywhere* — the React build
  // already has no inline scripts.
  "Content-Security-Policy":
    "default-src 'self'; " +
    "script-src 'self' 'wasm-unsafe-eval'; " +
    "style-src 'self'; " +
    "img-src 'self' https: data:; " +
    "connect-src 'self' wss: https:; " +
    "font-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'",
  // Defence in depth: even if a future browser ignores `frame-ancestors`,
  // the legacy header denies framing.
  "X-Frame-Options": "DENY",
  // HSTS: the worker is HTTPS-only by deployment; declaring the year-long
  // intent is cheap and removes one round-trip downgrade on first hit.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};
