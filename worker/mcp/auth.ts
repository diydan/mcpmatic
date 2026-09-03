/**
 * Bearer-token auth for the MCP surface.
 *
 * Phase 1: the bearer token IS the session token (64 hex chars).
 * Phase 1.5: a registered OAuth client may also present a 43-char
 * base64url access token minted at /oauth/token — in that case the bearer
 * is resolved, via `resolveMcpToken`, to the underlying session token
 * before the SessionDO is looked up. The AuthOk / AuthErr shape returned
 * here is unchanged so downstream `handleMcp` does not need to know which
 * kind of bearer it received.
 */

import { resolveMcpToken } from "../oauth/mcp-bridge";

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/);
  return match ? match[1] : null;
}

export type AuthOk = { ok: true; token: string };
export type AuthErr = {
  ok: false;
  response: Response;
};

/**
 * Pulls the bearer token from the request and resolves it — through
 * `resolveMcpToken` — to the underlying session token. Returns either a
 * valid session token or a fully-formed 401 Response the caller can
 * return directly. The actual DO lookup is left to the caller.
 */
export async function authenticate(
  request: Request,
  env: Env,
): Promise<AuthOk | AuthErr> {
  const bearer = extractBearer(request);
  if (!bearer) return unauthorized();

  const sessionToken = await resolveMcpToken(bearer, env);
  if (!sessionToken) return unauthorized();

  return { ok: true, token: sessionToken };
}

function unauthorized(): AuthErr {
  return {
    ok: false,
    response: new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Unauthorized" },
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "WWW-Authenticate": 'Bearer realm="browsermatic"',
        },
      },
    ),
  };
}
