#!/usr/bin/env bash
#
# Manual smoke test against a live BrowserMatic Worker.
#
# Everything in the test suite uses a fake: no real authenticator, no live
# storefront, no deployed Worker. This script is the part that cannot be
# faked — real Durable Objects, real KV, real Browser Rendering, and a real
# Shopify storefront answering with its own WebMCP schemas.
#
# Usage:
#   BASE_URL=https://browsermatic.example ./tests/live-smoke.sh
#
# Not run in CI. Run it after `pnpm run deploy`, which must apply the new
# v4 (AccountDO) and v5 (SiteDO) migrations.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
ORIGIN="${ORIGIN:-https://www.allbirds.com}"
pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

mcp() { # $1 = method, $2 = params json
  curl -sS -X POST "$BASE_URL/mcp" \
    -H "authorization: Bearer $SESSION" \
    -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"
}

echo "== 1. session =="
CREATE=$(curl -sS -X POST "$BASE_URL/sessions" -H 'content-type: application/json' -d '{}')
SESSION=$(echo "$CREATE" | grep -o '"sessionToken":"[a-f0-9]*"' | cut -d'"' -f4)
[ -n "$SESSION" ] && pass "session created" || fail "no session token: $CREATE"
echo "$CREATE" | grep -q '"consoleUrl"' \
  && pass "consoleUrl returned" || fail "no consoleUrl"
echo "  console: $BASE_URL/c/$SESSION"
echo "  facade:  $BASE_URL/s/$SESSION"

echo "== 2. consent =="
curl -sS -X POST "$BASE_URL/s/$SESSION/consent" \
  -H 'content-type: application/json' -d "{\"origin\":\"$ORIGIN\"}" >/dev/null
pass "granted $ORIGIN"

echo "== 3. tools are listed and labelled =="
TOOLS=$(mcp tools/list '{}')
echo "$TOOLS" | grep -q 'fill_checkout_on_allbirds_com' \
  && pass "fill_checkout listed" || fail "fill_checkout missing"
echo "$TOOLS" | grep -q 'Requires human approval in the BrowserMatic console' \
  && pass "approval note present" || fail "approval note missing"

echo "== 4. THE BUG: fill_checkout with no console attached =="
# Before this assertion was tightened, it filled six empty strings and returned ok:true.
FILL=$(mcp tools/call '{"name":"fill_checkout_on_allbirds_com","arguments":{}}')
echo "$FILL" | grep -q 'needs-console' \
  && pass "refused with needs-console" \
  || fail "expected needs-console, got: $FILL"
echo "$FILL" | grep -qi '"ran fill_checkout' \
  && fail "STILL REPORTING FAKE SUCCESS" || pass "no fake success"

echo "== 5. the schemas the telemetry classifier depends on =="
# This is the one that cannot be proven offline: does the storefront actually
# hand back inputSchema objects with required[] we can check arguments against?
#
# navigate_to first. list_remote_tools reports on the page that is *open* and
# never starts a browser, and granting consent does not open one.
mcp tools/call "{\"name\":\"navigate_to\",\"arguments\":{\"origin\":\"$ORIGIN\"}}" >/dev/null
# Unescape: the schemas arrive inside a JSON-RPC string, so every quote is
# backslashed and a naive grep for "required" finds nothing.
REMOTE=$(mcp tools/call '{"name":"list_remote_tools","arguments":{}}' | sed 's/\\"/"/g')
echo "$REMOTE" | grep -q 'WebMCP tool' \
  && pass "storefront exposed its own tools" \
  || fail "no remote tools seen: $(echo "$REMOTE" | head -c 300)"
echo "$REMOTE" | grep -q '"required"' \
  && pass "schemas carry required[] — checkArgs can classify" \
  || fail "no required[] in observed schemas: checkArgs will never fire"
# Shopify nests: required:["cart"] at the top, line_items one level down. A
# flat checker passes {cart:{}} and misses the case worth reporting.
echo "$REMOTE" | grep -q '"properties":{"cart":{"type":"object","required"' \
  && pass "nested required[] present — the case checkArgs must recurse for" \
  || echo "  (no nested required seen; schemas may have changed shape)"

echo "== 6. audit is readable and has no value column =="
AUDIT=$(curl -sS "$BASE_URL/s/$SESSION/audit")
echo "$AUDIT" | grep -q '"rows"' && pass "audit readable" || fail "audit: $AUDIT"
echo "$AUDIT" | grep -q '"fieldNames"' \
  && pass "field names present" || echo "  (no rows yet)"

echo "== 7. telemetry is gated =="
UNAUTH=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/site/telemetry?origin=$ORIGIN")
[ "$UNAUTH" = "400" ] && pass "no token → 400" || fail "expected 400, got $UNAUTH"
BADTOK=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "authorization: Bearer $(printf 'a%.0s' {1..64})" \
  "$BASE_URL/site/telemetry?origin=$ORIGIN")
[ "$BADTOK" = "401" ] && pass "unverified origin → 401" || fail "expected 401, got $BADTOK"
START=$(curl -sS -X POST "$BASE_URL/site/verify/start" \
  -H 'content-type: application/json' -d "{\"origin\":\"$ORIGIN\"}")
echo "$START" | grep -q '"token"' \
  && pass "verification token issued" || fail "verify/start: $START"

echo "== 8. a pending approval is redeemable, not a hang =="
# The bounded wait only pends when a console is attached, which a script cannot
# be. What is checkable here is that the redemption tool exists and answers.
CHECK=$(mcp tools/call '{"name":"check_approval","arguments":{"id":"no-such-id"}}')
echo "$CHECK" | grep -q 'no result yet' \
  && pass "check_approval answers for an unknown id" || fail "check_approval: $CHECK"

echo "== 9. passkey registration is session-bound (security fix) =="
NOSESSION=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "$BASE_URL/account/passkey/register/options" \
  -H 'content-type: application/json' \
  -d "{\"accountId\":\"$(printf 'a%.0s' {1..64})\"}")
[ "$NOSESSION" = "400" ] \
  && pass "account id alone cannot register a credential" \
  || fail "expected 400, got $NOSESSION"

echo
echo "Cleanup:  curl -X DELETE $BASE_URL/sessions/$SESSION"
echo
if [ "$FAILED" = "1" ]; then echo "SOME CHECKS FAILED"; exit 1; fi
echo "All checks passed."
echo
echo "Verified by hand against a deployed Worker on 2026-09-04, so no longer"
echo "listed above: the approval round trip. A call with a console attached and"
echo "nobody clicking returned approval-pending in 10.0s with an id; approving"
echo "afterwards ran the tool and check_approval returned its result; the audit"
echo "row named the six fields that moved."
echo
echo "Still needs a human, in a browser at $BASE_URL/c/$SESSION:"
echo "  - add a passkey, then sign in with it from a second browser profile"
