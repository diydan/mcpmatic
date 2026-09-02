import { SessionDO } from "./session-do";
import { OAuthClientDO } from "./oauth/client-do";
import { OAuthCodeDO } from "./oauth/code-do";
import { FACADE_HEADERS } from "./facade-headers";
import { isPrivateUrl } from "./is-private-url";
import { makeResolve4 } from "./doh-resolve4";

export { SessionDO, OAuthClientDO, OAuthCodeDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/sessions") {
      return createSession(request, env);
    }

    const sessionMatch = path.match(/^\/sessions\/([A-Fa-f0-9]{64})$/);
    if (sessionMatch && request.method === "DELETE") {
      const stub = env.SESSION.getByName(sessionMatch[1]);
      await stub.destroy();
      return json({ ok: true });
    }

    const consentMatch = path.match(/^\/s\/([A-Fa-f0-9]{64})\/consent$/);
    if (consentMatch && request.method === "GET") {
      const stub = env.SESSION.getByName(consentMatch[1]);
      return json(await stub.listConsent());
    }
    if (consentMatch && request.method === "POST") {
      const body = (await request.json()) as { origin?: unknown };
      const origin = typeof body.origin === "string" ? body.origin : "";
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        return json({ ok: false, error: "origin must be https" }, 400);
      }
      if (parsed.protocol !== "https:") {
        return json({ ok: false, error: "origin must be https" }, 400);
      }
      const stub = env.SESSION.getByName(consentMatch[1]);
      await stub.grantConsent(origin);
      return json({ ok: true, origin });
    }

    if (path === "/mcp") {
      const { handleMcp } = await import("./mcp/server");
      return handleMcp(request, env);
    }

    // OAuth 2.1 (RFC 6749 / 7591 / 7636) surface. The /oauth/* wildcard in
    // wrangler.jsonc `run_worker_first` ensures these reach the Worker instead
    // of falling through to the SPA fallback. Sub-dispatch is by exact
    // segment; the method guards are enforced by the handlers themselves
    // (POST for register + token, GET/POST for authorize).
    if (path.startsWith("/oauth/")) {
      const sub = path.slice("/oauth/".length);
      if (sub === "register") {
        const { handleRegister } = await import("./oauth/register");
        return handleRegister(request, env);
      }
      if (sub === "authorize") {
        const { handleAuthorize } = await import("./oauth/authorize");
        return handleAuthorize(request, env);
      }
      if (sub === "token") {
        const { handleToken } = await import("./oauth/token");
        return handleToken(request, env);
      }
      return new Response("not found", { status: 404, headers: FACADE_HEADERS });
    }

    const bridgeMatch = path.match(/^\/s\/([A-Fa-f0-9]{64})\/bridge$/);
    if (bridgeMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", {
          status: 426,
          headers: FACADE_HEADERS,
        });
      }
      const stub = env.SESSION.getByName(bridgeMatch[1]);
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404, headers: FACADE_HEADERS });
  },
} satisfies ExportedHandler<Env>;

async function createSession(request: Request, env: Env): Promise<Response> {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const sessionToken = [...tokenBytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Optional `{ origin: string }` body. Validation lives HERE in the worker,
  // not in the DO — the DO is a persistence layer; the worker is the policy
  // layer. Back-compat is load-bearing: Home.tsx and any older caller POSTs
  // without a body, and that flow must continue to work identically.
  //
  // Body parse rules:
  //   - No body at all (Content-Length 0 or absent / non-JSON Content-Type)
  //     → treated as no origin. Old clients are unaffected.
  //   - application/json with invalid JSON → 400 { error: "invalid body" }.
  //   - application/json with `{}` or no `origin` key → no origin.
  //   - { origin: "" } → no origin (empty string treated as absent).
  //   - { origin: <non-string> } → 400 { error: "invalid origin" }.
  //   - { origin: <string> } that fails parse / https / isPrivateUrl
  //     → 400 { error: "invalid origin" }.
  const seededOrigin = await parseAndValidateOrigin(request);
  // `parseAndValidateOrigin` returns a `Response` on any 400 path; the
  // caller forwards it directly. `undefined` means "no origin to seed"
  // (back-compat or absent/empty `origin` field).
  if (seededOrigin instanceof Response) return seededOrigin;

  // Plant a sentinel row on the DO so the OAuth authorize handler can
  // verify the token before binding it to an auth code. Without this,
  // a pasted random string would mint an OAuth code bound to a chosen
  // token. If `seededOrigin` is set, the DO persists it in the same
  // SQL transaction as the sentinel row (see SessionDO.initSession).
  const stub = env.SESSION.getByName(sessionToken);
  await stub.initSession(sessionToken, seededOrigin);
  const origin = new URL(request.url).origin;
  return json({
    sessionToken,
    url: `${origin}/s/${sessionToken}`,
  });
}

/**
 * Read the optional `{ origin }` body of POST /sessions and validate it.
 * Returns `undefined` for "no seed" (back-compat) and a string for the
 * validated origin. Returns a `Response` to short-circuit on any 400 — the
 * caller forwards it to the client.
 */
async function parseAndValidateOrigin(
  request: Request,
): Promise<string | undefined | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  // No body or non-JSON Content-Type: back-compat path. `request.json()`
  // would throw on these (an empty body is a syntax error in JSON), so we
  // must skip it. Most callers today send no body at all.
  if (!contentType.includes("application/json")) return undefined;
  let body: { origin?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const raw = body.origin;
  // Absent / explicit-empty / null: no seed. We do not validate these.
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    return json({ error: "invalid origin" }, 400);
  }
  // Lenient parsing: if the input has no scheme, treat it as https://.
  // Users often type "example.com" or "www.example.com" without the
  // protocol; auto-prepending matches user expectation. `www.` is left
  // in place — it's a distinct origin in URL semantics, and the consent
  // list keys on it.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    try {
      parsed = new URL(`https://${raw}`);
    } catch {
      return json({ error: "invalid origin" }, 400);
    }
  }
  // Same protocol rule as the existing /s/<token>/consent endpoint: the
  // remote browser is reached over https only. isPrivateUrl will also
  // fail-closed on non-http(s) schemes, but we short-circuit early so the
  // user gets a clear message.
  if (parsed.protocol !== "https:") {
    return json({ error: "invalid origin" }, 400);
  }
  // Normalize to canonical origin (scheme + host + port) so the seeded
  // consent matches what /s/<token>/consent expects and what subsequent
  // tool calls (e.g. navigate_to) will check against. Drops path/query.
  const normalized = parsed.origin;
  // SSRF guard: fail-closed on private IP literals, on resolver errors,
  // and on any resolved A/AAAA record pointing at private space. See
  // worker/is-private-url.ts for the threat model and tests/ssrf.test.ts
  // for the guard's own coverage.
  const blocked = await isPrivateUrl(normalized, makeResolve4());
  if (blocked) {
    return json({ error: "invalid origin" }, 400);
  }
  return normalized;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...FACADE_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}
