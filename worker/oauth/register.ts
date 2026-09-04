/**
 * Dynamic Client Registration per RFC 7591.
 *
 * POST /oauth/register accepts `{redirect_uris, client_name?}` and creates a
 * new client: a fresh UUID `client_id` and a server-generated 256-bit
 * `client_secret` (base64url-no-pad). The client is persisted to the
 * OAuthClientDO keyed by its `client_id` with the secret STORED AS A
 * SALTED SHA-256 HASH — the plaintext is never persisted (DSRV-L1), and
 * the hash is verified in constant time on token exchange (DSRV-L2).
 *
 * SSRF guard: every `redirect_uri` is run through `isPrivateUrl`, which
 * fail-closes on private IP literals, on resolver errors, and on any
 * resolved A/AAAA record pointing at private space. This is the same
 * guard the navigation tools use (`session-do.ts`); a private URL must
 * never end up as a redirect target.
 *
 * The plaintext `client_secret` is echoed back ONCE in the response. Per
 * RFC 7591 §3.2.1 the server MAY include `client_secret` in the response
 * and the spec only forbids it for public clients — for Phase 1.5 all
 * registered clients are confidential. The `clientSecretHash` is
 * deliberately STRIPPED from the response (T6-2 ruling): the API must
 * not echo the persisted secret, even as a hash, so a careless client
 * that round-trips the response into another storage tier does not
 * leak it a second time.
 */
import { isPrivateUrl } from "../is-private-url";
import { makeResolve4 } from "../doh-resolve4";
import { consume } from "../rate-limit";
import type { OAuthClient } from "./types";
import { base64urlNoPad } from "./encoding";
import { hashSecret } from "./secret";

/** Stub origin for the OAuthClientDO fetch — the DO ignores the URL. */
const DO_STUB_ORIGIN = "https://stub";

const REGISTRATION_PATH = "/oauth/register";

export function isRegistrationPath(path: string): boolean {
  return path === REGISTRATION_PATH;
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  // Rate-limit before any other work: a flood of registrations would force a
  // DoH round trip and a DO write per call, which is what we are protecting
  // against. The Cloudflare WAF bounds this at the edge; this bucket is the
  // finer-grained tier that rejects a runaway loop before the validation
  // pass below starts.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rl = await consume(env, "oauth-register", ip, { limit: 5, windowSeconds: 60 });
  if (!rl.ok) {
    return Response.json(
      { error: "rate_limited", error_description: "too many registrations; try again shortly" },
      {
        status: 429,
        headers: { "cache-control": "no-store" },
      },
    );
  }

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
  // The salt for DSRV-L1 is the clientId itself — already unique (UUID v4)
  // and recorded alongside the hash on registration, so verification at
  // /oauth/token can re-derive the same digest without storing the salt.
  const clientSecretHash = await hashSecret(clientSecret, clientId);
  const client: OAuthClient = {
    clientId,
    clientSecretHash,
    redirectUris: body.redirect_uris as string[],
    clientName: typeof body.client_name === "string" ? body.client_name : "unnamed",
    createdAt: Date.now(),
  };

  // Persist to the DO. The DO ignores the URL — only the JSON body and the
  // method are significant. See worker/oauth/client-do.ts.
  const stub = env.OAUTH_CLIENT.getByName(clientId);
  await stub.fetch(`${DO_STUB_ORIGIN}/register`, {
    method: "POST",
    body: JSON.stringify(client),
  });

  // Strip the persisted hash from the response. The OAuthClient shape that
  // landed in the DO carries `clientSecretHash`; the registrant only needs
  // the id, the redirect URIs, the name, the createdAt, and the plaintext
  // `clientSecret` (echoed exactly once for confidential clients per RFC
  // 7591 §3.2.1).
  const { clientSecretHash: _omit, ...clientPublic } = client;
  return Response.json(
    { ...clientPublic, clientSecret },
    { status: 201 },
  );
}
