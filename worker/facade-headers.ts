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
 * CSP notes:
 *   - `default-src 'self'` is the tight default; any deviation must be
 *     explicit (Google Fonts + the inline theme-bootstrap).
 *   - `script-src 'self' 'unsafe-inline'` allows the inline theme
 *     bootstrap in index.html. The alternative is to extract the script
 *     to an external file — see the audit for the tradeoff.
 *   - `style-src ... 'unsafe-inline'` allows Google Fonts CSS (which
 *     embeds inline @font-face declarations) and the inline `<style>`
 *     blocks Vite injects.
 *   - `connect-src 'self'` restricts fetch / XHR to the worker origin;
 *     cross-origin requests fail closed.
 */
export const FACADE_HEADERS: Record<string, string> = {
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "tools=*",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'",
};
