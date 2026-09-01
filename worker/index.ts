import { SessionDO } from "./session-do";
import { OAuthClientDO } from "./oauth/client-do";
import { OAuthCodeDO } from "./oauth/code-do";
import { FACADE_HEADERS } from "./facade-headers";

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
  // Plant a sentinel row on the DO so the OAuth authorize handler can
  // verify the token before binding it to an auth code. Without this,
  // a pasted random string would mint an OAuth code bound to a chosen
  // token.
  const stub = env.SESSION.getByName(sessionToken);
  await stub.initSession(sessionToken);
  const origin = new URL(request.url).origin;
  return json({
    sessionToken,
    url: `${origin}/s/${sessionToken}`,
  });
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
