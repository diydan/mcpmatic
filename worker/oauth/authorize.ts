/**
 * Authorization endpoint per RFC 6749 §4.1.1 (authorization code grant).
 *
 * GET /oauth/authorize validates the request:
 *   - method is GET or POST (405 otherwise)
 *   - response_type=code (required; 400 invalid_request otherwise — checked
 *     before any DO call so we don't leak whether a client_id exists when
 *     the caller doesn't follow the authorization-code protocol)
 *   - client_id is present and resolves via OAuthClientDO
 *   - redirect_uri is one of the client.redirectUris (pre-validated at
 *     registration time by `isPrivateUrl`, Task 5)
 *   - state is present and preserved verbatim into the redirect
 *   - code_challenge + code_challenge_method=S256 are present (PKCE
 *     mandatory; `plain` is rejected)
 *
 * Dispatch:
 *   - GET → render the consent page. Params come from `url.searchParams`.
 *     The session_token is NOT in the URL on this path — the user pastes
 *     it into the form before submitting, so it never leaks via Referer
 *     or browser history.
 *   - POST → decision path. Params come from `await request.formData()`.
 *     Verifies the session_token against SessionDO (a random pasted string
 *     must NOT mint an OAuth code), then either issues the AuthCode and
 *     redirects, or denies and redirects with `error=access_denied`.
 *
 * The session_token carries the user's consented origins — downstream
 * /oauth/token resolves it. No separate consent mechanism is invented here
 * (constraint: consent gates visibility via session_token).
 *
 * Security: the consent HTML page and the 302 redirects both carry
 * `FACADE_HEADERS` (incl. `Referrer-Policy: no-referrer`) plus
 * `Cache-Control: no-store`. The session_token flows through the consent
 * POST body (never the URL), so we keep it out of the `Referer` and out
 * of any intermediary cache. `wrangler.jsonc` has
 * `observability.head_sampling_rate: 1` — every URL is written to Workers
 * Logs verbatim — so the consent page itself must not be cached either.
 */
import { FACADE_HEADERS } from "../facade-headers";
import { base64urlNoPad } from "./encoding";
import type { AuthCode, OAuthClient } from "./types";

/** Stub origin for OAuthClientDO / OAuthCodeDO / SessionDO fetch. */
const DO_STUB_ORIGIN = "https://stub";

const NO_STORE = { "Cache-Control": "no-store" };

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
  /** null on the first-visit GET (the user has not pasted one yet). */
  sessionToken: string | null;
};

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  // Method guard. GET = render, POST = decide. Anything else → 405 so
  // legacy clients that tried to send consent=approve via GET are
  // forced to migrate to POST.
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { ...FACADE_HEADERS, ...NO_STORE, allow: "GET, POST" },
    });
  }

  // GET-with-consent is the legacy decision path: a client that hasn't
  // migrated to POST. Reject explicitly so the failure mode is loud.
  if (request.method === "GET") {
    const url = new URL(request.url);
    const legacy = url.searchParams.get("consent");
    if (legacy === "approve" || legacy === "deny") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...FACADE_HEADERS, ...NO_STORE, allow: "GET, POST" },
      });
    }
  }

  let params: AuthorizeParams;
  let consentField: string | null = null;
  if (request.method === "GET") {
    params = paramsFromUrl(new URL(request.url));
  } else {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      formData = new FormData();
    }
    params = readParamsFromFormData(formData);
    const consentRaw = formData.get("consent");
    consentField = typeof consentRaw === "string" ? consentRaw : null;
  }

  // Validation shared by GET and POST.
  const validation = await validateParams(params, env);
  if (!validation.ok) return validation.response;

  // GET → render consent page. The first-visit GET has no session_token
  // (the user pastes it in the form before submitting), so we don't try
  // to verify one here. Verification happens on the POST decision path.
  if (request.method === "GET") {
    return new Response(
      renderConsentPage({
        clientId: params.clientId,
        redirectUri: params.redirectUri,
        state: params.state,
        codeChallenge: params.codeChallenge,
      }),
      {
        headers: {
          ...FACADE_HEADERS,
          ...NO_STORE,
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  }

  // POST → decision path. session_token MUST be present here (the form
  // marks it as required). Verify it against the SessionDO sentinel row
  // before binding it to an auth code.
  const sessionToken = params.sessionToken;
  if (!sessionToken) {
    return Response.json(
      { error: "invalid_request", error_description: "session_token required" },
      { status: 400 },
    );
  }
  const sessionStub = env.SESSION.getByName(sessionToken);
  const sessionRes = await sessionStub.fetch(`${DO_STUB_ORIGIN}/check`);
  if (sessionRes.status !== 200) {
    return Response.json(
      { error: "invalid_request", error_description: "session token not found" },
      { status: 400 },
    );
  }

  // Consent decision. The form has two submit buttons (approve / deny)
  // so the field name `consent` carries whichever the user clicked.
  const consent = consentField;
  if (consent !== "approve" && consent !== "deny") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  if (consent === "deny") {
    const sep = params.redirectUri.includes("?") ? "&" : "?";
    // Response.redirect(url, status, init) drops init.headers in the
    // Workers runtime — build the redirect manually so the security
    // headers actually reach the wire.
    return new Response(null, {
      status: 302,
      headers: {
        location: `${params.redirectUri}${sep}error=access_denied&state=${encodeURIComponent(params.state)}`,
        ...FACADE_HEADERS,
        ...NO_STORE,
      },
    });
  }

  const code = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const authCode: AuthCode = {
    code,
    clientId: params.clientId,
    userSessionToken: sessionToken,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: "S256",
    // 10 minutes per the brief.
    expiresAt: Date.now() + 10 * 60 * 1000,
    used: false,
  };
  const codeStub = env.OAUTH_CODE.getByName(code);
  await codeStub.fetch(`${DO_STUB_ORIGIN}/issue`, {
    method: "POST",
    body: JSON.stringify(authCode),
  });

  const sep = params.redirectUri.includes("?") ? "&" : "?";
  return new Response(null, {
    status: 302,
    headers: {
      location: `${params.redirectUri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(params.state)}`,
      ...FACADE_HEADERS,
      ...NO_STORE,
    },
  });
}

function paramsFromUrl(url: URL): AuthorizeParams {
  return {
    clientId: url.searchParams.get("client_id") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    state: url.searchParams.get("state") ?? "",
    codeChallenge: url.searchParams.get("code_challenge") ?? "",
    codeChallengeMethod: url.searchParams.get("code_challenge_method") ?? "",
    responseType: url.searchParams.get("response_type") ?? "",
    sessionToken: null,
  };
}

function readParamsFromFormData(formData: FormData): AuthorizeParams {
  return {
    clientId: stringField(formData, "client_id"),
    redirectUri: stringField(formData, "redirect_uri"),
    state: stringField(formData, "state"),
    codeChallenge: stringField(formData, "code_challenge"),
    codeChallengeMethod: stringField(formData, "code_challenge_method"),
    responseType: stringField(formData, "response_type"),
    sessionToken: stringFieldOrNull(formData, "session_token"),
  };
}

function stringField(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

function stringFieldOrNull(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  if (typeof v !== "string") return null;
  return v.length > 0 ? v : null;
}

async function validateParams(
  params: AuthorizeParams,
  env: Env,
): Promise<{ ok: true; client: OAuthClient } | { ok: false; response: Response }> {
  // response_type=code is required by the MCP authorization spec. Checked
  // FIRST so a missing/wrong value never reveals whether a client_id is
  // registered.
  if (params.responseType !== "code") {
    return { ok: false, response: Response.json({ error: "invalid_request" }, { status: 400 }) };
  }
  if (!params.clientId || !params.redirectUri || !params.state || !params.codeChallenge) {
    return { ok: false, response: Response.json({ error: "invalid_request" }, { status: 400 }) };
  }
  if (params.codeChallengeMethod !== "S256") {
    return {
      ok: false,
      response: Response.json(
        { error: "invalid_request", error_description: "PKCE S256 required" },
        { status: 400 },
      ),
    };
  }
  const clientStub = env.OAUTH_CLIENT.getByName(params.clientId);
  const clientRes = await clientStub.fetch(`${DO_STUB_ORIGIN}/get`);
  if (clientRes.status !== 200) {
    return {
      ok: false,
      response: Response.json({ error: "invalid_client" }, { status: 400 }),
    };
  }
  const client = (await clientRes.json()) as OAuthClient;
  if (!client.redirectUris.includes(params.redirectUri)) {
    return {
      ok: false,
      response: Response.json({ error: "invalid_redirect_uri" }, { status: 400 }),
    };
  }
  return { ok: true, client };
}

function renderConsentPage(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  let redirectHost = params.redirectUri;
  try {
    redirectHost = new URL(params.redirectUri).host;
  } catch {
    // Keep the raw redirect URI when it cannot be parsed as a URL.
  }
  const esc = {
    clientId: escapeHtml(params.clientId),
    redirectUri: escapeHtml(params.redirectUri),
    redirectHost: escapeHtml(redirectHost),
    state: escapeHtml(params.state),
    codeChallenge: escapeHtml(params.codeChallenge),
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize ${esc.clientId}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #444; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.75rem; margin: 1rem 0; }
  dt { font-weight: 600; }
  dd { margin: 0; word-break: break-all; }
  form { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
  label { display: block; font-size: 0.85rem; }
  input[type=text] { width: 100%; padding: 0.4rem; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  .actions { display: flex; gap: 0.5rem; }
  button { padding: 0.5rem 1rem; border: 1px solid #444; background: #fff; cursor: pointer; font: inherit; }
  button[name=consent][value=approve] { background: #0a7; color: #fff; border-color: #0a7; }
</style>
</head>
<body>
<h1>Authorize ${esc.clientId}</h1>
<p>An OAuth client is requesting access on your behalf.</p>
<dl>
  <dt>Client ID</dt><dd>${esc.clientId} <small>(redirects to ${esc.redirectHost})</small></dd>
  <dt>Redirect URI</dt><dd>${esc.redirectUri}</dd>
  <dt>State</dt><dd>${esc.state}</dd>
</dl>
<!-- POST so the session_token never lands in the URL. -->
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="client_id" value="${esc.clientId}">
  <input type="hidden" name="redirect_uri" value="${esc.redirectUri}">
  <input type="hidden" name="state" value="${esc.state}">
  <input type="hidden" name="code_challenge" value="${esc.codeChallenge}">
  <input type="hidden" name="code_challenge_method" value="S256">
  <input type="hidden" name="response_type" value="code">
  <label>Session token (from <code>/sessions</code>)
    <input type="text" name="session_token" required autocomplete="off">
  </label>
  <div class="actions">
    <button type="submit" name="consent" value="approve">Approve</button>
    <button type="submit" name="consent" value="deny">Deny</button>
  </div>
</form>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
