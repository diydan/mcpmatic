# MCP Server Surface — Phase 1.5: OAuth 2.0 + PKCE Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace bearer-token auth on `/mcp` with full OAuth 2.0 + PKCE so spec-compliant MCP clients (Claude desktop, ChatGPT) handle the auth flow themselves — no token paste, no manual `/sessions` call, no copy-paste UX. Existing session tokens remain valid as a fallback for clients that don't support OAuth (or for human engineers debugging).

**Architecture:** Three new Worker routes — `POST /oauth/register` (RFC 7591 dynamic client registration), `GET /oauth/authorize` (consent UI + redirect), `POST /oauth/token` (code-for-token exchange with PKCE verification). Two new Durable Objects: `OAuthClientDO` (per-client metadata + registered redirect URIs) and `OAuthCodeDO` (short-lived, single-use auth codes with PKCE challenge). The `/mcp` route's auth module grows a path that accepts OAuth access tokens alongside the existing session-token bearer path; both end up resolving to the same `SessionDO` so tool listing and execution are unchanged. WebMCP façade at `/s/<token>` is untouched.

**Tech Stack:** Cloudflare Workers + Durable Objects (existing), TypeScript, vitest. New OAuth-specific deps: none — PKCE uses Web Crypto (built into the Workers runtime), no `jose` or `oauth2-server` packages.

**Spec:** Phase 1 plan (`docs/superpowers/plans/2026-09-01-mcp-server-phase-1.md`), RFC 6749 (OAuth 2.0), RFC 7636 (PKCE), RFC 7591 (Dynamic Client Registration). This plan argues from those.

---

## Global Constraints

These constraints apply to every task. They are non-negotiable.

1. **No changes to the audit table shape.** Rows remain `{origin, tool, field_names, ts}`. No value column. Ever.
2. **No changes to SSRF check behavior.** `isPrivateUrl` runs on every navigation, both via MCP and via the existing façade.
3. **Origin-qualified tool names.** Tools surfaced by MCP keep their `*_on_<origin>` suffixes. Never bare names.
4. **Consent gates MCP tool visibility, not just execution.** `tools/list` returns only tools for granted origins. Ungranted origins are invisible, not "denied at call time."
5. **The session DO's `runTool` is the only path.** MCP `tools/call` routes through it; no parallel implementation.
6. **No LLM in the MCP hot path.** MCP `tools/call` is a deterministic bridge to the existing executeTool path.
7. **Bash commands are run from the repo root** unless stated otherwise.
8. **Every commit message starts with `feat:`, `fix:`, `test:`, or `chore:`** and ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
9. **PKCE is mandatory.** Every issued auth code carries an `S256` challenge. Plain (no PKCE) is not supported.
10. **Bearer-token auth stays.** The existing session-token path remains functional for debugging and for clients that don't support OAuth. Both paths resolve to the same `SessionDO`.

---

## File Structure

New files for Phase 1.5:

| File | Purpose |
|---|---|
| `worker/oauth/types.ts` | OAuth types: `OAuthClient`, `AuthCode`, `AccessToken`, `PkceChallenge` |
| `worker/oauth/store.ts` | Storage interface — DO-backed for clients + codes, KV-backed for tokens |
| `worker/oauth/client-do.ts` | `OAuthClientDO`: per-client metadata, registered redirect URIs, revocation |
| `worker/oauth/code-do.ts` | `OAuthCodeDO`: short-lived (10min), single-use auth codes with PKCE challenge |
| `worker/oauth/pkce.ts` | PKCE verification: `verifyPkce(verifier, challenge)` using Web Crypto SHA-256 |
| `worker/oauth/register.ts` | `POST /oauth/register` handler (RFC 7591) |
| `worker/oauth/authorize.ts` | `GET /oauth/authorize` handler + hosted consent UI |
| `worker/oauth/token.ts` | `POST /oauth/token` handler (code-for-token + refresh) |
| `worker/oauth/mcp-bridge.ts` | Map OAuth access token → session token (read-only) |
| `tests/oauth-types.test.ts` | Type-level tests for OAuth types |
| `tests/oauth-pkce.test.ts` | PKCE math: known-answer test vectors from RFC 7636 §4.6 |
| `tests/oauth-register.test.ts` | Client registration happy path + error paths |
| `tests/oauth-authorize.test.ts` | Authorization flow: code issuance + redirect_uri validation |
| `tests/oauth-token.test.ts` | Token exchange + refresh + invalid_grant |
| `tests/oauth-mcp-bridge.test.ts` | OAuth token → session token mapping |

Modified files:

| File | Change |
|---|---|
| `worker/mcp/auth.ts` | Accept OAuth access tokens alongside session tokens |
| `worker/index.ts` | Register `/oauth/register`, `/oauth/authorize`, `/oauth/token` routes |
| `wrangler.jsonc` | Add `/oauth/*` to `run_worker_first` |
| `durable_objects` bindings | Add `OAUTH_CLIENT` (class `OAuthClientDO`) and `OAUTH_CODE` (class `OAuthCodeDO`) |
| `migrations` | Tag `v2` registering the new classes |

---

### Task 1: OAuth types and storage interface

**Files:**
- Create: `worker/oauth/types.ts`
- Create: `worker/oauth/store.ts`
- Create: `tests/oauth-types.test.ts`

Define the core OAuth data shapes and a storage interface that can be backed by either Durable Objects or KV.

**Interfaces:**
- `OAuthClient = { clientId: string; clientSecret: string; redirectUris: string[]; clientName: string; createdAt: number }`
- `AuthCode = { code: string; clientId: string; userSessionToken: string; redirectUri: string; codeChallenge: string; codeChallengeMethod: "S256"; expiresAt: number; used: boolean }`
- `AccessToken = { token: string; clientId: string; userSessionToken: string; scope: string; expiresAt: number; refreshToken: string }`
- `PkceChallenge = { codeChallenge: string; codeChallengeMethod: "S256" }`

```typescript
// worker/oauth/types.ts
export type OAuthClient = {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName: string;
  createdAt: number;
};

export type AuthCode = {
  code: string;
  clientId: string;
  userSessionToken: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: number;
  used: boolean;
};

export type AccessToken = {
  token: string;
  clientId: string;
  userSessionToken: string;
  scope: string;
  expiresAt: number;
  refreshToken: string;
};

export type PkceChallenge = {
  codeChallenge: string;
  codeChallengeMethod: "S256";
};
```

TDD: write `tests/oauth-types.test.ts` with three type-level cases (structure compile-checks). Same caveat as Phase 1 Task 1: `tsc --noEmit` is the real RED signal.

**Commit:** `feat(oauth): add OAuth types and storage interface`

---

### Task 2: PKCE verification

**Files:**
- Create: `worker/oauth/pkce.ts`
- Create: `tests/oauth-pkce.test.ts`

PKCE (RFC 7636) verifies that the client that exchanges an auth code for a token is the same client that requested the code. The client sends `code_challenge` at `/authorize` time and `code_verifier` at `/token` time; the server checks `base64url(SHA256(verifier)) == challenge`.

```typescript
// worker/oauth/pkce.ts
/**
 * Verify a PKCE code_verifier against a stored S256 code_challenge.
 * Returns true iff base64url-no-pad(SHA256(verifier)) === challenge.
 *
 * RFC 7636 §4.6 — verifier is 43-128 chars from [A-Z][a-z][0-9]-._~
 */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const computed = base64urlNoPad(new Uint8Array(digest));
  // Constant-time compare to prevent timing attacks.
  return timingSafeEqual(computed, challenge);
}

function base64urlNoPad(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

TDD: include the RFC 7636 §4.6 known-answer test vector:
- `verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"`
- expected `code_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"`

Also test rejection: wrong verifier, missing challenge, malformed verifier (too short, bad chars).

**Commit:** `feat(oauth): PKCE verification with S256 + constant-time compare`

---

### Task 3: OAuthClientDO — dynamic client registration storage

**Files:**
- Create: `worker/oauth/client-do.ts`
- Create: `tests/oauth-client-do.test.ts`

A Durable Object per client. Stored by `clientId`. Holds metadata + registered redirect URIs. Provides idempotent `get` / `register` / `revoke`.

```typescript
// worker/oauth/client-do.ts
import type { OAuthClient } from "./types";

export class OAuthClientDO implements DurableObject {
  private state: DurableObjectState;
  private client: OAuthClient | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      this.client = (await this.state.storage.get<OAuthClient>("client")) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/get" && request.method === "GET") {
      return this.client
        ? Response.json(this.client)
        : new Response("not found", { status: 404 });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = (await request.json()) as OAuthClient;
      await this.state.storage.put("client", body);
      this.client = body;
      return Response.json(body);
    }
    if (url.pathname === "/revoke" && request.method === "POST") {
      await this.state.storage.deleteAll();
      this.client = null;
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }
}
```

TDD: tests for `register` (idempotent overwrite), `get` (404 when absent), `revoke` (204 + subsequent 404).

**Commit:** `feat(oauth): OAuthClientDO for dynamic client registration`

---

### Task 4: OAuthCodeDO — single-use auth codes with PKCE

**Files:**
- Create: `worker/oauth/code-do.ts`
- Create: `tests/oauth-code-do.test.ts`

A Durable Object per auth code. Stored by `code` (a random 32-byte base64url string). Holds the challenge, redirect URI, bound user session token, and a `used` flag. `consume()` is atomic: it succeeds once and rejects thereafter, preventing replay.

```typescript
// worker/oauth/code-do.ts
import type { AuthCode } from "./types";

export class OAuthCodeDO implements DurableObject {
  private state: DurableObjectState;
  private code: AuthCode | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      this.code = (await this.state.storage.get<AuthCode>("code")) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/issue" && request.method === "POST") {
      const body = (await request.json()) as AuthCode;
      await this.state.storage.put("code", body);
      this.code = body;
      return Response.json({ code: body.code });
    }
    if (url.pathname === "/consume" && request.method === "POST") {
      if (!this.code) return new Response("invalid_grant", { status: 400 });
      if (this.code.used) return new Response("invalid_grant", { status: 400 });
      if (Date.now() > this.code.expiresAt) return new Response("invalid_grant", { status: 400 });
      this.code = { ...this.code, used: true };
      await this.state.storage.put("code", this.code);
      return Response.json(this.code);
    }
    return new Response("not found", { status: 404 });
  }
}
```

TDD: tests for `issue` (returns code), `consume` (returns code once, then 400), expiry (Date.now() > expiresAt → 400).

**Commit:** `feat(oauth): OAuthCodeDO with single-use consume`

---

### Task 5: Client registration handler (POST /oauth/register)

**Files:**
- Create: `worker/oauth/register.ts`
- Create: `tests/oauth-register.test.ts`
- Modify: `worker/index.ts` (route)
- Modify: `wrangler.jsonc` (`run_worker_first`)

RFC 7591 dynamic client registration. Generates a `clientId` (UUID v4) and a `clientSecret` (32 random bytes, base64url). Validates `redirect_uris` against a blocklist of private URLs (SSRF protection — same `isPrivateUrl` used elsewhere). Returns the registered client.

```typescript
// worker/oauth/register.ts
export async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = (await request.json()) as { redirect_uris?: string[]; client_name?: string };
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return Response.json({ error: "invalid_request", error_description: "redirect_uris required" }, { status: 400 });
  }
  for (const uri of body.redirect_uris) {
    const u = new URL(uri);
    if (isPrivateUrl(u)) {
      return Response.json({ error: "invalid_redirect_uri", error_description: `private URL: ${uri}` }, { status: 400 });
    }
  }
  const clientId = crypto.randomUUID();
  const clientSecret = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const client: OAuthClient = {
    clientId,
    clientSecret,
    redirectUris: body.redirect_uris,
    clientName: body.client_name ?? "unnamed",
    createdAt: Date.now(),
  };
  const stub = env.OAUTH_CLIENT.getByName(clientId);
  await stub.fetch("https://stub/register", { method: "POST", body: JSON.stringify(client) });
  // Don't echo client_secret in production responses — but for Phase 1.5 testing we do.
  return Response.json(client, { status: 201 });
}
```

TDD: tests for happy path (201 + clientId), missing redirect_uris (400), private URL in redirect_uris (400), wrong method (405).

**Commit:** `feat(oauth): dynamic client registration at POST /oauth/register`

---

### Task 6: Authorization endpoint (GET /oauth/authorize)

**Files:**
- Create: `worker/oauth/authorize.ts`
- Create: `tests/oauth-authorize.test.ts`
- Modify: `worker/index.ts` (route)
- Modify: `wrangler.jsonc` (`run_worker_first`)

Validates the request (client_id exists, redirect_uri is registered, code_challenge is S256, state is present). On first visit, redirects to a hosted consent page. After consent, generates an auth code, stores it in `OAuthCodeDO`, and redirects to the client's `redirect_uri` with `code` and `state` query params.

```typescript
// worker/oauth/authorize.ts
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const consent = url.searchParams.get("consent"); // "approve" or "deny" on the consent form POST

  if (!clientId || !redirectUri || !state || !codeChallenge) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  if (codeChallengeMethod !== "S256") {
    return Response.json({ error: "invalid_request", error_description: "PKCE S256 required" }, { status: 400 });
  }
  // Validate the client exists.
  const clientStub = env.OAUTH_CLIENT.getByName(clientId);
  const clientRes = await clientStub.fetch("https://stub/get");
  if (clientRes.status !== 200) return Response.json({ error: "invalid_client" }, { status: 400 });
  const client = (await clientRes.json()) as OAuthClient;
  if (!client.redirectUris.includes(redirectUri)) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }

  // No consent decision yet → render the consent page.
  if (consent !== "approve" && consent !== "deny") {
    return new Response(renderConsentPage(clientId, redirectUri, state, codeChallenge), {
      headers: { "content-type": "text/html" },
    });
  }

  if (consent === "deny") {
    return Response.redirect(`${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`, 302);
  }

  // Issue an auth code. The user must have a session token from /sessions; for Phase 1.5
  // we accept it via the consent form (cookie or form field) and bind it to the code.
  const sessionToken = url.searchParams.get("session_token");
  if (!sessionToken) return Response.json({ error: "invalid_request", error_description: "session_token required" }, { status: 400 });

  const code = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const authCode: AuthCode = {
    code,
    clientId,
    userSessionToken: sessionToken,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: "S256",
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    used: false,
  };
  const codeStub = env.OAUTH_CODE.getByName(code);
  await codeStub.fetch("https://stub/issue", { method: "POST", body: JSON.stringify(authCode) });

  const sep = redirectUri.includes("?") ? "&" : "?";
  return Response.redirect(`${redirectUri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, 302);
}
```

The consent page is rendered server-side as minimal HTML. CSS lives in a string constant; no client framework. The form POSTs back to `/oauth/authorize` with `consent=approve` (or `deny`) + `session_token` (a form field where the user pastes their session token from `/sessions`).

TDD: tests for happy path (302 with code + state), invalid client_id (400), unregistered redirect_uri (400), missing code_challenge (400), non-S256 method (400), denied consent (302 with error=access_denied).

**Commit:** `feat(oauth): authorization endpoint with hosted consent UI`

---

### Task 7: Token endpoint (POST /oauth/token)

**Files:**
- Create: `worker/oauth/token.ts`
- Create: `tests/oauth-token.test.ts`
- Modify: `worker/index.ts` (route)
- Modify: `wrangler.jsonc` (`run_worker_first`)

Two grant types: `authorization_code` and `refresh_token`. Both require client authentication via `clientId` + `clientSecret` (Basic auth or form params). The auth code path: validate code, verify PKCE, mark code as used, mint access + refresh tokens. The refresh path: validate refresh token, mint a new access token, optionally rotate refresh.

```typescript
// worker/oauth/token.ts
export async function handleToken(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id") as string;
  const clientSecret = form.get("client_secret") as string;

  // Authenticate client.
  const clientStub = env.OAUTH_CLIENT.getByName(clientId);
  const clientRes = await clientStub.fetch("https://stub/get");
  if (clientRes.status !== 200) return oauthError("invalid_client", 401);
  const client = (await clientRes.json()) as OAuthClient;
  if (client.clientSecret !== clientSecret) return oauthError("invalid_client", 401);

  if (grantType === "authorization_code") {
    return exchangeCode(form, env, client);
  }
  if (grantType === "refresh_token") {
    return refreshToken(form, env, client);
  }
  return oauthError("unsupported_grant_type", 400);
}

async function exchangeCode(form: FormData, env: Env, client: OAuthClient): Promise<Response> {
  const code = form.get("code") as string;
  const redirectUri = form.get("redirect_uri") as string;
  const codeVerifier = form.get("code_verifier") as string;
  if (!code || !redirectUri || !codeVerifier) return oauthError("invalid_request", 400);

  const codeStub = env.OAUTH_CODE.getByName(code);
  const consumeRes = await codeStub.fetch("https://stub/consume", { method: "POST" });
  if (consumeRes.status !== 200) return oauthError("invalid_grant", 400);
  const authCode = (await consumeRes.json()) as AuthCode;
  if (authCode.clientId !== client.clientId) return oauthError("invalid_grant", 400);
  if (authCode.redirectUri !== redirectUri) return oauthError("invalid_grant", 400);

  const ok = await verifyPkce(codeVerifier, authCode.codeChallenge);
  if (!ok) return oauthError("invalid_grant", 400);

  // Mint tokens.
  const accessToken = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const refreshToken = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const tok: AccessToken = {
    token: accessToken,
    clientId: client.clientId,
    userSessionToken: authCode.userSessionToken,
    scope: "mcp:tools",
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
    refreshToken,
  };
  // Store in KV (key: token, TTL: expiresAt)
  await env.OAUTH_TOKENS.put(`token:${accessToken}`, JSON.stringify(tok), { expirationTtl: 3600 });
  await env.OAUTH_TOKENS.put(`refresh:${refreshToken}`, JSON.stringify(tok), { expirationTtl: 86400 * 30 });

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: "mcp:tools",
  });
}

async function refreshToken(form: FormData, env: Env, client: OAuthClient): Promise<Response> {
  const rt = form.get("refresh_token") as string;
  if (!rt) return oauthError("invalid_request", 400);
  const tokJson = await env.OAUTH_TOKENS.get(`refresh:${rt}`);
  if (!tokJson) return oauthError("invalid_grant", 400);
  const tok = JSON.parse(tokJson) as AccessToken;
  if (tok.clientId !== client.clientId) return oauthError("invalid_grant", 400);

  // Rotate: issue new access token, new refresh token, invalidate old refresh.
  const accessToken = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const newRefresh = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
  const newTok: AccessToken = { ...tok, token: accessToken, refreshToken: newRefresh, expiresAt: Date.now() + 3600 * 1000 };
  await env.OAUTH_TOKENS.put(`token:${accessToken}`, JSON.stringify(newTok), { expirationTtl: 3600 });
  await env.OAUTH_TOKENS.put(`refresh:${newRefresh}`, JSON.stringify(newTok), { expirationTtl: 86400 * 30 });
  await env.OAUTH_TOKENS.delete(`refresh:${rt}`);

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: newRefresh,
    scope: tok.scope,
  });
}

function oauthError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}
```

TDD: tests for happy path (200 + access_token + refresh_token), wrong client_secret (401), wrong PKCE verifier (400 invalid_grant), replay of consumed code (400 invalid_grant), redirect_uri mismatch (400), refresh with valid token (200 + new tokens), refresh with revoked token (400).

**Commit:** `feat(oauth): token endpoint with code exchange + refresh`

---

### Task 8: MCP auth bridge — accept OAuth access tokens

**Files:**
- Create: `worker/oauth/mcp-bridge.ts`
- Create: `tests/oauth-mcp-bridge.test.ts`
- Modify: `worker/mcp/auth.ts` (extend to recognize OAuth tokens)

The `/mcp` auth module currently extracts a session-token bearer. It should ALSO accept OAuth access tokens. To distinguish: session tokens are 64-hex chars (Phase 1 shape); OAuth access tokens are 43-char base64url (Phase 1.5 shape). Disambiguate by length/charset, then resolve.

```typescript
// worker/oauth/mcp-bridge.ts
/**
 * Given a Bearer token from the /mcp Authorization header, return the
 * underlying session token. Handles both Phase 1 session tokens (64-hex)
 * and Phase 1.5 OAuth access tokens (43-char base64url).
 */
export async function resolveMcpToken(token: string, env: Env): Promise<string | null> {
  if (/^[a-f0-9]{64}$/i.test(token)) return token; // Phase 1 session token
  if (/^[A-Za-z0-9\-_]{43}$/.test(token)) {
    // OAuth access token — look up in KV.
    const tokJson = await env.OAUTH_TOKENS.get(`token:${token}`);
    if (!tokJson) return null;
    const tok = JSON.parse(tokJson) as AccessToken;
    return tok.userSessionToken;
  }
  return null;
}
```

Modify `worker/mcp/auth.ts` `authenticate(request, env)` to call `resolveMcpToken` and use the returned session token. Update tests in `tests/mcp/auth.test.ts` if they exist.

TDD: tests for session token pass-through (returns same), OAuth token resolution (returns userSessionToken from KV), unknown token (returns null), malformed token (returns null).

**Commit:** `feat(oauth): /mcp accepts OAuth access tokens alongside session tokens`

---

### Task 9: Wire OAuth routes in worker entry point

**Files:**
- Modify: `worker/index.ts` (add /oauth/register, /oauth/authorize, /oauth/token branches)
- Modify: `wrangler.jsonc` (`run_worker_first` and durable_objects + migrations)

Register the three routes. Add `/oauth/*` to `run_worker_first`. Add `OAUTH_CLIENT` and `OAUTH_CODE` durable object bindings, plus a `v2` migration. Add `OAUTH_TOKENS` KV namespace binding.

```typescript
// worker/index.ts (new branches after /mcp)
if (path.startsWith("/oauth/")) {
  const sub = path.slice("/oauth/".length);
  if (sub === "register" && request.method === "POST") {
    const { handleRegister } = await import("./oauth/register");
    return handleRegister(request, env);
  }
  if (sub === "authorize") {
    const { handleAuthorize } = await import("./oauth/authorize");
    return handleAuthorize(request, env);
  }
  if (sub === "token" && request.method === "POST") {
    const { handleToken } = await import("./oauth/token");
    return handleToken(request, env);
  }
  return new Response("not found", { status: 404 });
}
```

wrangler.jsonc additions:
```jsonc
"run_worker_first": [
  "/sessions", "/sessions/*", "/s/*/bridge", "/s/*/consent", "/mcp",
  "/oauth/*"  // NEW
],
"durable_objects": {
  "bindings": [
    { "name": "SESSION", "class_name": "SessionDO" },
    { "name": "OAUTH_CLIENT", "class_name": "OAuthClientDO" },  // NEW
    { "name": "OAUTH_CODE", "class_name": "OAuthCodeDO" }        // NEW
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["SessionDO"] },
  { "tag": "v2", "new_sqlite_classes": ["OAuthClientDO", "OAuthCodeDO"] }  // NEW
],
"kv_namespaces": [
  { "binding": "OAUTH_TOKENS", "id": "<from wrangler kv:namespace create>" }
]
```

TDD: a smoke test against `pnpm dev` covering all three routes end-to-end. Steps:
1. `POST /oauth/register` with `{"redirect_uris":["https://example.com/callback"],"client_name":"test"}` → 201 with clientId + clientSecret
2. `GET /oauth/authorize?client_id=<id>&redirect_uri=https://example.com/callback&state=xyz&code_challenge=<S256>&code_challenge_method=S256&consent=approve&session_token=<64hex>` → 302 to `https://example.com/callback?code=<code>&state=xyz`
3. `POST /oauth/token` with `grant_type=authorization_code&code=<code>&redirect_uri=https://example.com/callback&code_verifier=<verifier>&client_id=<id>&client_secret=<secret>` → 200 with access_token + refresh_token
4. `POST /mcp` with `Authorization: Bearer <access_token>` → 200 with serverInfo (validates the bridge)

**Commit:** `feat(oauth): wire OAuth routes + bindings + migration v2`

---

### Task 10: End-to-end OAuth flow test

**Files:**
- Create: `tests/oauth-e2e.test.ts`

A single test that runs the full Phase 1.5 OAuth flow against the deployed Worker (after Task 9's smoke test passes). Uses `@modelcontextprotocol/sdk` to drive the `/mcp` endpoint with the OAuth access token at the end.

Steps:
1. Register a client (POST /oauth/register)
2. Compute PKCE verifier + challenge (using Web Crypto)
3. Hit /oauth/authorize with consent=approve (simulating user clicks "Approve")
4. Extract auth code from redirect Location header
5. Exchange code for token (POST /oauth/token)
6. Use access token to call /mcp initialize
7. Verify serverInfo returns "mcpmatic"

TDD: red first — without OAuth registered, the test should fail at step 1. After all upstream tasks land, it should pass.

**Commit:** `test(oauth): end-to-end OAuth flow against SDK client`

---

### Task 11: Update SPEC.md and document the Phase 1.5 surface

**Files:**
- Modify: `README.md` (or `docs/SPEC.md` if it exists) — add a "Phase 1.5: OAuth" section
- Modify: `tests/MCP_CLIENTS.md` — update the Findings section with the actual outcomes (after Task 9's smoke test)

Document the new auth surface: which routes exist, what the consent flow looks like, how to register a client, how to obtain a token via the SDK. Reference RFC 6749, 7636, 7591.

**Commit:** `docs: document Phase 1.5 OAuth surface`

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| OAuth 2.0 authorization_code grant | Tasks 6, 7 |
| PKCE S256 mandatory | Tasks 2, 6, 7 |
| Dynamic client registration (RFC 7591) | Tasks 3, 5 |
| Refresh tokens | Task 7 |
| Bearer token still works | Task 8 |
| `/mcp` accepts OAuth access tokens | Task 8 |
| Audit table unchanged | All tasks |
| runTool still the only execution path | All tasks |
| Consent gates tool visibility | Inherited from Phase 1 |

**Placeholder scan:** No "TBD" / "implement later" / "add appropriate handling" in this plan.

**Type consistency:**
- `OAuthClient` defined in Task 1, used in Tasks 3, 5, 6, 7. ✓
- `AuthCode` defined in Task 1, used in Tasks 4, 6, 7. ✓
- `AccessToken` defined in Task 1, used in Tasks 7, 8. ✓
- `verifyPkce` defined in Task 2, used in Task 7. ✓

**No changes to:**
- Audit table schema
- SSRF checks (`worker/is-private-url.ts`)
- WebMCP façade routes (`/sessions`, `/s/<token>`, `/s/<token>/consent`, `/s/<token>/bridge`)
- Tool execution path (`runTool`, `runStep`)
- Existing consent storage
