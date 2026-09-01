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
 */
export const FACADE_HEADERS: Record<string, string> = {
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "tools=*",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
