#!/usr/bin/env bash
#
# Register the Viber webhook with the Viber Bot API.
# Idempotent — re-running just rebinds the URL.
#
# Required env vars:
#   VIBER_BOT_TOKEN        — bot auth token from Viber
#   VIBER_WEBHOOK_URL      — public HTTPS URL, e.g. https://viber.maximh.us/viber/webhook
#
set -euo pipefail

: "${VIBER_BOT_TOKEN:?VIBER_BOT_TOKEN is required}"
: "${VIBER_WEBHOOK_URL:?VIBER_WEBHOOK_URL is required}"

curl -sS -X POST https://chatapi.viber.com/pa/set_webhook \
    -H "X-Viber-Auth-Token: ${VIBER_BOT_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$(cat <<EOF
{
  "url": "${VIBER_WEBHOOK_URL}",
  "event_types": ["message", "conversation_started", "subscribed", "unsubscribed", "delivered", "failed"],
  "send_name": true,
  "send_photo": true
}
EOF
)"
echo
