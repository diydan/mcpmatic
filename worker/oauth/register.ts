/**
 * Dynamic Client Registration per RFC 7591.
 *
 * POST /oauth/register accepts `{redirect_uris, client_name?}` and creates a
 * new client: a fresh UUID `client_id` and a server-generated 256-bit
 * `client_secret` (base64url-no-pad). The client is persisted to the
 * OAuthClientDO keyed by its `client_id`.
 *
 * SSRF guard: every `redirect_uri` is run through `isPrivateUrl`, which
 * fail-closes on private IP literals, on resolver errors, and on any
 * resolved A/AAAA record pointing at private space. This is the same
 * guard the navigation tools use (`session-do.ts`); a private URL must
 * never end up as a redirect target.
 *
 * The client_secret is echoed back in the response. Per RFC 7591 §3.2.1
 * the server MAY include `client_secret` in the response and the spec only
 * forbids it for public clients — all registered clients today are
 * confidential. This keeps the test path trivial.
 */
import { isPrivateUrl } from "../is-private-url";
import { makeResolve4 } from "../doh-resolve4";
import type { OAuthClient, OAuthClientRegistration } from "./types";
import { base64urlNoPad } from "./encoding";
import { freshSalt, hashClientSecret } from "./secret";

/** Stub origin for the OAuthClientDO fetch — the DO ignores the URL. */
const DO_STUB_ORIGIN = "https://stub";

const REGISTRATION_PATH = "/oauth/register";

/**
 * Cap on persisted `client_name` length. The audit (§1.7 of
 * task-1-report.md) flagged that an unbounded `client_name` costs 1 byte
 * of durable storage per byte of caller input. 200 chars is enough for
 * any reasonable human-readable label without becoming a cost or abuse
 * surface; longer inputs are truncated.
 */
export const CLIENT_NAME_MAX_LEN = 200;

export function isRegistrationPath(path: string): boolean {
  return path === REGISTRATION_PATH;
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { error: "invalid_request", error_description: "request body must be JSON" },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return Response.json(
      { error: "invalid_request", error_description: "redirect_uris required" },
      { status: 400 },
    );
  }

  // Reject any URI that does not parse as an http(s) URL or that resolves to
  // a private address. Bail on the FIRST offender with a clear description.
  // We resolve once per call rather than per URI; the resolver is stateless
  // and the cost is one extra DoH round-trip per URI.
  const resolve4 = makeResolve4();
  for (const raw of body.redirect_uris as unknown[]) {
    if (typeof raw !== "string") {
      return Response.json(
        {
          error: "invalid_request",
          error_description: "redirect_uris must be strings",
        },
        { status: 400 },
      );
    }
    if (await isPrivateUrl(raw, resolve4)) {
      return Response.json(
        {
          error: "invalid_redirect_uri",
          error_description: `private URL: ${raw}`,
        },
        { status: 400 },
      );
    }
  }

  const clientId = crypto.randomUUID();
  const clientSecret = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  // Hash at rest: never persist the plaintext client_secret. The plaintext
  // is returned to the caller once (RFC 7591 §3.2.1, confidential clients)
  // and then lives only in the caller's memory. See worker/oauth/secret.ts.
  const clientSecretSalt = freshSalt();
  const clientSecretHash = await hashClientSecret(clientSecret, clientSecretSalt);

  // client_name: missing → "unnamed" (unchanged); explicit empty/whitespace
  // → 400 invalid_request; over CLIENT_NAME_MAX_LEN → truncate.
  const rawName = body.client_name;
  let clientName: string;
  if (rawName === undefined || rawName === null) {
    clientName = "unnamed";
  } else if (typeof rawName !== "string") {
    return Response.json(
      {
        error: "invalid_request",
        error_description: "client_name must be a string",
      },
      { status: 400 },
    );
  } else if (rawName.trim().length === 0) {
    return Response.json(
      {
        error: "invalid_request",
        error_description: "client_name must not be empty or whitespace",
      },
      { status: 400 },
    );
  } else {
    clientName =
      rawName.length > CLIENT_NAME_MAX_LEN
        ? rawName.slice(0, CLIENT_NAME_MAX_LEN)
        : rawName;
  }

  const client: OAuthClient = {
    clientId,
    clientSecretHash,
    clientSecretSalt,
    redirectUris: body.redirect_uris as string[],
    clientName,
    createdAt: Date.now(),
  };

  // Persist to the DO. The DO ignores the URL — only the JSON body and the
  // method are significant. See worker/oauth/client-do.ts.
  const stub = env.OAUTH_CLIENT.getByName(clientId);
  await stub.fetch(`${DO_STUB_ORIGIN}/register`, {
    method: "POST",
    body: JSON.stringify(client),
  });

  // Echo the plaintext client_secret ONCE so the caller can authenticate
  // at /oauth/token. Subsequent /token calls authenticate against the hash;
  // no plaintext is ever stored on the server.
  const response: OAuthClientRegistration = {
    clientId,
    clientSecret,
    redirectUris: client.redirectUris,
    clientName: client.clientName,
    createdAt: client.createdAt,
  };
  return Response.json(response, { status: 201 });
}
