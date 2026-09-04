#!/usr/bin/env bash
#
# Manual OAuth end-to-end smoke test against a live browsermatic Worker.
#
# The CI integration test (tests/oauth-e2e.test.ts) covers the full OAuth flow
# in-process; this script is for running the same flow against a deployed URL
# (local `pnpm dev`, staging, or production) to prove the wire format is
# correct end-to-end — including `run_worker_first` routing, real DOs, and
# real KV.
#
# Usage:
#   BASE_URL=https://browsermatic.example ./tests/oauth-smoke.sh
#
# What it does:
#   1. POST /sessions                          → sessionToken (64 hex)
#   2. POST /oauth/register                    → clientId + clientSecret
#   3. POST /oauth/authorize                   → 302 with code (parse location)
#   4. POST /oauth/token (grant=authz_code)    → access_token + refresh_token
#   5. POST /mcp (Bearer access_token)         → 200 (bridge resolves)
#
# The PKCE verifier is the RFC 7636 §4.6 known-answer test pair, so the
# SHA-256 challenge is well-known and the script doesn't have to compute it.
#
# This script is intentionally not run in CI — it requires a deployed Worker
# with bindings + KV namespace. Use it after a `pnpm exec wrangler deploy`
# to sanity-check the live surface.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
REDIRECT_URI="https://example.com/callback"
STATE="smoke-$(date +%s)"
PKCE_VERIFIER="dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
PKCE_CHALLENGE="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

assert_status() {
  local got="$1" want="$2" step="$3"
  if [[ "$got" != "$want" ]]; then
    red "FAIL [$step]: expected HTTP $want, got $got"
    exit 1
  fi
  green "OK   [$step]: HTTP $got"
}

bold "Base URL: $BASE_URL"
echo

# ---------------------------------------------------------------------------
# Step 1: POST /sessions
# ---------------------------------------------------------------------------
bold "1. POST /sessions"
session_resp=$(curl -sS -X POST "$BASE_URL/sessions")
session_token=$(printf '%s' "$session_resp" | sed -nE 's/.*"sessionToken":"([a-f0-9]{64})".*/\1/p')
if [[ ! "$session_token" =~ ^[a-f0-9]{64}$ ]]; then
  red "FAIL: /sessions did not return a 64-hex sessionToken. Got: $session_resp"
  exit 1
fi
green "OK   sessionToken=$session_token"
echo

# ---------------------------------------------------------------------------
# Step 2: POST /oauth/register
# ---------------------------------------------------------------------------
bold "2. POST /oauth/register"
register_resp=$(curl -sS -w "\n%{http_code}" -X POST "$BASE_URL/oauth/register" \
  -H "content-type: application/json" \
  -d "{\"redirect_uris\":[\"$REDIRECT_URI\"],\"client_name\":\"smoke-test\"}")
register_body=$(printf '%s' "$register_resp" | sed '$d')
register_status=$(printf '%s' "$register_resp" | tail -n1)
assert_status "$register_status" "201" "register"

client_id=$(printf '%s' "$register_body" | sed -nE 's/.*"clientId":"([^"]+)".*/\1/p')
client_secret=$(printf '%s' "$register_body" | sed -nE 's/.*"clientSecret":"([^"]+)".*/\1/p')
[[ -n "$client_id" && -n "$client_secret" ]] || { red "FAIL: missing clientId/clientSecret"; exit 1; }
green "OK   clientId=$client_id"
echo

# ---------------------------------------------------------------------------
# Step 3: POST /oauth/authorize (consent=approve, PKCE S256)
# ---------------------------------------------------------------------------
bold "3. POST /oauth/authorize (consent=approve)"
authorize_resp=$(curl -sS -o /dev/null -w "%{http_code}\n%{redirect_url}" -X POST "$BASE_URL/oauth/authorize" \
  -H "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "response_type=code" \
  --data-urlencode "client_id=$client_id" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "state=$STATE" \
  --data-urlencode "code_challenge=$PKCE_CHALLENGE" \
  --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "session_token=$session_token" \
  --data-urlencode "consent=approve")
authorize_status=$(printf '%s' "$authorize_resp" | sed -n '1p')
authorize_location=$(printf '%s' "$authorize_resp" | sed -n '2p')
assert_status "$authorize_status" "302" "authorize"

code=$(printf '%s' "$authorize_location" | sed -nE "s/.*[?&]code=([^&]+).*/\\1/p")
state_back=$(printf '%s' "$authorize_location" | sed -nE "s/.*[?&]state=([^&]+).*/\\1/p")
[[ -n "$code" ]] || { red "FAIL: 302 missing code param. location=$authorize_location"; exit 1; }
[[ "$state_back" == "$STATE" ]] || { red "FAIL: state mismatch"; exit 1; }
green "OK   code=$code"
echo

# ---------------------------------------------------------------------------
# Step 4: POST /oauth/token (grant_type=authorization_code)
# ---------------------------------------------------------------------------
bold "4. POST /oauth/token (authorization_code)"
token_resp=$(curl -sS -w "\n%{http_code}" -X POST "$BASE_URL/oauth/token" \
  -H "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$code" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "code_verifier=$PKCE_VERIFIER" \
  --data-urlencode "client_id=$client_id" \
  --data-urlencode "client_secret=$client_secret")
token_body=$(printf '%s' "$token_resp" | sed '$d')
token_status=$(printf '%s' "$token_resp" | tail -n1)
assert_status "$token_status" "200" "token"

access_token=$(printf '%s' "$token_body" | sed -nE 's/.*"access_token":"([^"]+)".*/\1/p')
refresh_token=$(printf '%s' "$token_body" | sed -nE 's/.*"refresh_token":"([^"]+)".*/\1/p')
[[ -n "$access_token" ]] || { red "FAIL: no access_token"; exit 1; }
green "OK   access_token=$access_token"
echo

# ---------------------------------------------------------------------------
# Step 5: POST /mcp with Bearer access_token (bridge resolves → session DO)
# ---------------------------------------------------------------------------
bold "5. POST /mcp (Bearer access_token)"
mcp_status=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $access_token" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}')
assert_status "$mcp_status" "200" "mcp"

echo
green "All five steps passed. OAuth flow is live."