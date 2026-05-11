#!/usr/bin/env bash
#
# Synthetic webhook driver for local viber-proxy validation.
#
# Signs JSON payloads with VIBER_BOT_TOKEN (HMAC-SHA256, hex digest, lowercase)
# and POSTs them to the local viber-proxy. Mirrors the exact format Viber sends
# so the proxy cannot tell the difference. Runs every webhook code path:
#   - signature mismatch  → 403
#   - tampered body       → 403
#   - webhook ping        → 200, no-op
#   - DM message (linked)
#   - DM message (unlinked)
#   - DM message (dedupe replay)
#   - group message (linked)
#   - conversation_started (no context, redeem invalid, redeem valid)
#
# Required env:
#   VIBER_BOT_TOKEN     same secret the proxy is signing against (use 'local-test-token'
#                       when proxy runs with MOCK_VIBER_OUTBOUND=true)
#   CRON_SECRET_KEY     same secret event-planner /api/viber/* validates
#   CLERK_USER_ID       a real Clerk userId that exists in event-planner
#                       (read from your event-planner DB or Clerk dashboard)
#
# Optional env:
#   PROXY_URL           default http://localhost:8081
#   WEBAPP_URL          default http://localhost:3000
#   VIBER_USER_ID       default test-viber-user-1
#   VIBER_NAME          default "Test User"
#   GROUP_CHAT_ID       default test-group-1
#   LINK_CODE           if set, used for the conversation_started redeem test;
#                       otherwise a fresh code is minted via /api/viber/link/redeem
#                       (this requires CLERK_USER_ID and CRON_SECRET_KEY)
#
set -euo pipefail

PROXY_URL="${PROXY_URL:-http://localhost:8081}"
WEBAPP_URL="${WEBAPP_URL:-http://localhost:3000}"
VIBER_USER_ID="${VIBER_USER_ID:-test-viber-user-1}"
VIBER_NAME="${VIBER_NAME:-Test User}"
GROUP_CHAT_ID="${GROUP_CHAT_ID:-test-group-1}"

: "${VIBER_BOT_TOKEN:?VIBER_BOT_TOKEN required (use 'local-test-token' if proxy is in MOCK mode)}"
: "${CRON_SECRET_KEY:?CRON_SECRET_KEY required (same value as event-planner .env)}"
: "${CLERK_USER_ID:?CLERK_USER_ID required (real Clerk userId from event-planner)}"

PASS=0
FAIL=0

color() {
    local code="$1"; shift
    if [ -t 1 ]; then printf '\033[%sm%s\033[0m' "$code" "$*"; else printf '%s' "$*"; fi
}
ok()   { echo "  $(color '32' 'PASS') $*"; PASS=$((PASS+1)); }
fail() { echo "  $(color '31' 'FAIL') $*"; FAIL=$((FAIL+1)); }
title(){ echo; echo "$(color '36;1' "==> $*")"; }

# --- helpers ---------------------------------------------------------------

# Compute HMAC-SHA256 hex digest of stdin using VIBER_BOT_TOKEN.
sign() {
    openssl dgst -sha256 -hmac "$VIBER_BOT_TOKEN" -hex \
        | sed 's/^.*= //'   # GNU/BSD differ; strip "(stdin)= " prefix when present
}

# POST $1 raw body, with $2 signature header. Echoes "<http_code>\n<body>".
post_webhook() {
    local body="$1"
    local sig="$2"
    curl -sS -o /tmp/viber-resp.$$ -w '%{http_code}' \
        -X POST "$PROXY_URL/viber/webhook" \
        -H 'Content-Type: application/json' \
        -H "X-Viber-Content-Signature: $sig" \
        --data-binary "$body"
    echo
    cat /tmp/viber-resp.$$
    rm -f /tmp/viber-resp.$$
}

post_signed() {
    local body="$1"
    local sig
    sig=$(printf '%s' "$body" | sign)
    post_webhook "$body" "$sig"
}

# Mint a fresh link code by inserting directly via the redeem endpoint?
# No — redeem consumes a code, doesn't create one. Codes are created via
# the Clerk-authed /api/viber/link/create. For the local test we accept that
# you've generated one in the browser and exported it as $LINK_CODE.
# If absent, we skip the conversation_started "valid" test.

# --- preflight -------------------------------------------------------------

title "Preflight"
HEALTH=$(curl -sS "$PROXY_URL/healthz" || true)
if echo "$HEALTH" | grep -q '"ok":true'; then ok "viber-proxy /healthz reports ok"
else fail "viber-proxy /healthz: $HEALTH"; fi

# Webapp reachable?
WAH=$(curl -sS -o /dev/null -w '%{http_code}' "$WEBAPP_URL/api/viber/lookup" \
    -X POST -H 'Content-Type: application/json' -d '{}' || true)
if [ "$WAH" = "401" ] || [ "$WAH" = "400" ]; then ok "event-planner $WEBAPP_URL is reachable (got $WAH without bearer)"
else fail "event-planner $WEBAPP_URL not reachable as expected (got $WAH)"; fi

# --- pre-link the test Viber user via redeem path -------------------------
# To exercise the linked path we need ViberUser{viberUserId,clerkUserId}.
# The redeem endpoint inserts that row, but only with a valid code. So:
#   1) generate a code by inserting a ViberLinkCode directly via psql, OR
#   2) generate a code via /api/viber/link/create with a Clerk session cookie.
# We do neither here — instead we ASSUME you've already linked CLERK_USER_ID
# to VIBER_USER_ID (via the /account/link-viber UI in your browser, or
# manually). The lookup test below will tell you immediately if that's wrong.

title "Lookup: test Viber user must already be linked to CLERK_USER_ID"
LOOKUP=$(curl -sS -X POST "$WEBAPP_URL/api/viber/lookup" \
    -H "Authorization: Bearer $CRON_SECRET_KEY" -H 'Content-Type: application/json' \
    -d "{\"viberUserId\":\"$VIBER_USER_ID\"}")
echo "  $LOOKUP"
if echo "$LOOKUP" | grep -q '"linked":true'; then
    ok "Viber user $VIBER_USER_ID is linked"
else
    fail "Viber user $VIBER_USER_ID is NOT linked. Link it first: open $WEBAPP_URL/account/link-viber, generate a code, then redeem it via:
        curl -X POST $WEBAPP_URL/api/viber/link/redeem \\
          -H 'Authorization: Bearer \$CRON_SECRET_KEY' -H 'Content-Type: application/json' \\
          -d '{\"code\":\"<CODE>\",\"viberUserId\":\"$VIBER_USER_ID\",\"viberName\":\"$VIBER_NAME\"}'"
    echo
    echo "Cannot continue without a linked test user. Aborting."
    exit 1
fi

# --- 1. signature: missing header -----------------------------------------

title "Webhook: missing signature header → 403"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "$PROXY_URL/viber/webhook" \
    -H 'Content-Type: application/json' \
    --data-binary '{"event":"webhook"}')
if [ "$CODE" = "403" ]; then ok "got 403"; else fail "expected 403, got $CODE"; fi

# --- 2. signature: tampered body ------------------------------------------

title "Webhook: tampered body → 403"
GOOD_BODY='{"event":"webhook"}'
SIG=$(printf '%s' "$GOOD_BODY" | sign)
TAMPERED='{"event":"webhook","x":1}'
RESULT=$(post_webhook "$TAMPERED" "$SIG"); HTTP=${RESULT%%$'\n'*}
if [ "$HTTP" = "403" ]; then ok "got 403 on tampered body"; else fail "expected 403, got $HTTP"; fi

# --- 3. webhook ping ------------------------------------------------------

title "Webhook: 'webhook' ping event → 200"
RESULT=$(post_signed '{"event":"webhook"}'); HTTP=${RESULT%%$'\n'*}
if [ "$HTTP" = "200" ]; then ok "got 200"; else fail "expected 200, got $HTTP"; fi

# --- 4. unlinked DM → reply with link instructions -----------------------

title "Webhook: DM message from unlinked user → unlinked-reply branch"
UNLINKED_BODY=$(cat <<EOF
{"event":"message","timestamp":1700000000000,"message_token":1000001,
 "sender":{"id":"unlinked-viber-user-99","name":"Unlinked User"},
 "message":{"type":"text","text":"hello bot"}}
EOF
)
RESULT=$(post_signed "$UNLINKED_BODY"); HTTP=${RESULT%%$'\n'*}
if [ "$HTTP" = "200" ]; then ok "200 — check viber-proxy logs for '(mock) /send_message' with link instructions"
else fail "expected 200, got $HTTP"; fi

# --- 5. linked DM → routed to OpenClaw ------------------------------------

title "Webhook: DM message from linked user → routed to OpenClaw"
DM_BODY=$(cat <<EOF
{"event":"message","timestamp":1700000000001,"message_token":1000002,
 "sender":{"id":"$VIBER_USER_ID","name":"$VIBER_NAME"},
 "message":{"type":"text","text":"What is the time?"}}
EOF
)
RESULT=$(post_signed "$DM_BODY"); HTTP=${RESULT%%$'\n'*}
if [ "$HTTP" = "200" ]; then ok "200 — watch viber-proxy + openclaw logs for chat.send + final reply"
else fail "expected 200, got $HTTP"; fi

# --- 6. dedupe: replay same message_token → no second OpenClaw call -------

title "Webhook: replay same message_token → dedupe (no second OpenClaw call)"
RESULT=$(post_signed "$DM_BODY"); HTTP=${RESULT%%$'\n'*}
if [ "$HTTP" = "200" ]; then ok "200 — confirm viber-proxy logs say 'dedupe message_token 1000002'"
else fail "expected 200, got $HTTP"; fi

# --- 7. group message from linked user ------------------------------------

title "Webhook: group message from linked user → group reply branch"
GROUP_BODY=$(cat <<EOF
{"event":"message","timestamp":1700000000002,"message_token":1000003,
 "chat_id":"$GROUP_CHAT_ID",
 "sender":{"id":"$VIBER_USER_ID","name":"$VIBER_NAME"},
 "message":{"type":"text","text":"@bot intel on Acme"}}
EOF
)
RESULT=$(post_signed "$GROUP_BODY"); HTTP=${RESULT%%$'\n'*}
if [ "$HTTP" = "200" ]; then ok "200 — confirm viber-proxy logs show outbound with chat_id=$GROUP_CHAT_ID"
else fail "expected 200, got $HTTP"; fi

# --- 8. group message from unlinked user → group link reply ---------------

title "Webhook: group message from unlinked user → group reply with link URL"
GROUP_UNLINKED=$(cat <<EOF
{"event":"message","timestamp":1700000000003,"message_token":1000004,
 "chat_id":"$GROUP_CHAT_ID",
 "sender":{"id":"unlinked-viber-user-99","name":"Stranger"},
 "message":{"type":"text","text":"hi"}}
EOF
)
RESULT=$(post_signed "$GROUP_UNLINKED"); HTTP=${RESULT%%$'\n'*}
if [ "$HTTP" = "200" ]; then ok "200 — viber-proxy logs should show outbound mention to chat_id=$GROUP_CHAT_ID"
else fail "expected 200, got $HTTP"; fi

# --- 9. conversation_started: no context → welcome reply ------------------

title "Webhook: conversation_started without context → welcome message"
CS_NO_CTX=$(cat <<EOF
{"event":"conversation_started","timestamp":1700000000004,"message_token":1000005,
 "type":"open","user":{"id":"new-viber-user-1","name":"Newbie"}}
EOF
)
RESULT=$(post_signed "$CS_NO_CTX"); HTTP=${RESULT%%$'\n'*}; BODY=${RESULT#*$'\n'}
if [ "$HTTP" = "200" ] && echo "$BODY" | grep -q '"text"'; then
    ok "200 with TextMessage in body (Viber expects this for conversation_started)"
else fail "expected 200 + text body, got $HTTP / $BODY"; fi

# --- 10. conversation_started: invalid context → invalid-or-expired -------

title "Webhook: conversation_started with bogus context → invalid/expired reply"
CS_BAD=$(cat <<EOF
{"event":"conversation_started","timestamp":1700000000005,"message_token":1000006,
 "type":"open","context":"NEVER-EXISTED",
 "user":{"id":"new-viber-user-2","name":"Newbie2"}}
EOF
)
RESULT=$(post_signed "$CS_BAD"); HTTP=${RESULT%%$'\n'*}; BODY=${RESULT#*$'\n'}
if [ "$HTTP" = "200" ] && echo "$BODY" | grep -qi 'invalid\|expired'; then
    ok "200 with invalid/expired text"
else fail "expected 200 + invalid/expired, got $HTTP / $BODY"; fi

# --- 11. conversation_started: real context (only if LINK_CODE provided) --

if [ -n "${LINK_CODE:-}" ]; then
    title "Webhook: conversation_started with LINK_CODE → account linked"
    CS_GOOD=$(cat <<EOF
{"event":"conversation_started","timestamp":1700000000006,"message_token":1000007,
 "type":"open","context":"$LINK_CODE",
 "user":{"id":"new-viber-user-3","name":"Linkee"}}
EOF
    )
    RESULT=$(post_signed "$CS_GOOD"); HTTP=${RESULT%%$'\n'*}; BODY=${RESULT#*$'\n'}
    if [ "$HTTP" = "200" ] && echo "$BODY" | grep -q -i 'linked'; then
        ok "200 with success text — verify a ViberUser row was created"
    else fail "expected 200 + success text, got $HTTP / $BODY"; fi
else
    title "Webhook: conversation_started with real LINK_CODE → SKIPPED (no LINK_CODE provided)"
fi

# --- summary --------------------------------------------------------------

echo
echo "$(color '36;1' "Summary: $PASS passed, $FAIL failed")"
[ "$FAIL" = "0" ]
