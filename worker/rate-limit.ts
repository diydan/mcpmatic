/**
 * Per 2026-09-04 review (agent H4, M10): both `/oauth/register` and
 * `/account/passkey/login/options` are unauthenticated POST endpoints
 * that write to DOs / KV. A Cloudflare-side rate-limit rule covers the
 * per-IP edge, but a tier above that we also want a *bucket* for these
 * specific routes — they tolerate ~5/min from a single IP but not
 * thousands/sec. KV is the natural backing store here; the read is
 * one round trip, the write is amortized into the same call.
 *
 * The bucket is approximate: a 2-step read-modify-write has a race window,
 * which is acceptable because the limit is a soft ceiling — two concurrent
 * over-limit calls both see "under limit" and both write, and only ONE
 * extra call lands. Strict accounting would need an atomic counter KV
 * doesn't expose.
 */
const KEY = (route: string, ip: string) => `rl:${route}:${ip}`;

export async function consume(
  env: Env,
  route: string,
  ip: string,
  cfg: { limit: number; windowSeconds: number },
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const now = Date.now();
  const k = KEY(route, ip);
  // Fail open on KV errors: a transient KV hiccup must not 500 the OAuth
  // register flow. The Cloudflare WAF still bounds the per-IP rate at the
  // edge; this bucket is a finer-grained tier, not the only one.
  let current: { count: number; expiresAt: number } | null;
  try {
    current = (await env.OAUTH_TOKENS.get(k, "json")) as
      | { count: number; expiresAt: number }
      | null;
  } catch {
    return { ok: true };
  }
  if (current && current.expiresAt > now) {
    if (current.count >= cfg.limit) {
      return { ok: false, retryAfterSeconds: Math.ceil((current.expiresAt - now) / 1000) };
    }
    const next = { count: current.count + 1, expiresAt: current.expiresAt };
    try {
      await env.OAUTH_TOKENS.put(k, JSON.stringify(next), {
        expirationTtl: cfg.windowSeconds,
      });
    } catch {
      return { ok: true };
    }
  } else {
    try {
      await env.OAUTH_TOKENS.put(
        k,
        JSON.stringify({ count: 1, expiresAt: now + cfg.windowSeconds * 1000 }),
        { expirationTtl: cfg.windowSeconds },
      );
    } catch {
      return { ok: true };
    }
  }
  return { ok: true };
}
