/**
 * Bearer-token auth for the MCP surface.
 *
 * For Phase 1, the bearer token IS the existing session token. This trades
 * long-term persistence for reuse of the existing primitive. Long-lived MCP
 * tokens are Phase 1.5 (depends on ChatGPT auth-flow findings).
 */

const TOKEN_RE = /^[A-Fa-f0-9]{64}$/;

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/);
  return match ? match[1] : null;
}

export function isValidToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export type AuthOk = { ok: true; token: string };
export type AuthErr = {
  ok: false;
  response: Response;
};

/**
 * Pulls and validates the bearer token from the request. Returns either a
 * valid token or a fully-formed 401 Response the caller can return directly.
 *
 * The actual DO lookup is left to the caller — auth.ts is pure and easily
 * testable, server.ts handles env-bound concerns.
 */
export function authenticate(request: Request): AuthOk | AuthErr {
  const token = extractBearer(request);
  if (!token || !isValidToken(token)) {
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
            "WWW-Authenticate": 'Bearer realm="mcpmatic"',
          },
        },
      ),
    };
  }
  return { ok: true, token };
}
