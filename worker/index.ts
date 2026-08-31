import { SessionDO } from "./session-do";

export { SessionDO };

const FACADE_HEADERS: Record<string, string> = {
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "tools=*",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/sessions") {
      return createSession(request);
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

async function createSession(request: Request): Promise<Response> {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const sessionToken = [...tokenBytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
