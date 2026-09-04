/**
 * Bearer-token auth for the MCP surface.
 *
 * The bearer at /mcp is one of two shapes — both are accepted and both
 * resolve to a session token before the SessionDO is consulted:
 *
 *   - A 64-hex session token, pasted directly into the MCP server config
 *     by ChatGPT or Claude. The bearer IS the session.
 *   - A 43-char base64url access token minted at /oauth/token. `resolveMcpToken`
 *     looks it up in `OAUTH_TOKENS` and returns the `userSessionToken` it
 *     was bound to at issue time.
 *
 * The `AuthOk` / `AuthErr` shape returned here is the same for both kinds
 * so downstream `handleMcp` does not need to know which bearer it received.
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
