# Viber Local Test Plan

This document describes how to validate the Viber integration end-to-end on a developer laptop **without ever touching a production Viber bot or Viber's servers**. Everything here runs against `localhost`.

The companion script `local-test.sh` automates the webhook half of this plan. The webapp half is a short sequence of `curl` commands you run by hand once.

---

## What this validates

| Layer | Local? | How |
|---|---|---|
| Prisma `ViberLinkCode` / `ViberUser` migration | ✅ | `npx prisma migrate dev` |
| `/api/viber/link/create` (Clerk-authed) | ✅ | Browser at `/account/link-viber` |
| `/api/viber/link/redeem` (bearer-authed) | ✅ | `curl` |
| `/api/viber/lookup` (bearer-authed, with role from Clerk) | ✅ | `curl` + `local-test.sh` preflight |
| `/api/intelligence/session-by-userid` (bearer-authed, action token) | ✅ | `curl` |
| viber-proxy `/healthz` | ✅ | `curl` |
| Webhook HMAC-SHA256 signature verification (positive + negative) | ✅ | `local-test.sh` |
| Webhook event dispatch (`webhook` ping, `conversation_started`, DM `message`, group `message`, dedupe) | ✅ | `local-test.sh` |
| viber-proxy → event-planner round-trip on every webhook | ✅ | `local-test.sh` (lookup + session mint visible in logs) |
| viber-proxy → OpenClaw round-trip (chat.send, agent stream, final) | ✅ | `local-test.sh` (final reply visible in logs) |
| Outbound `https://chatapi.viber.com/pa/send_message` | ⚠️ stubbed | `MOCK_VIBER_OUTBOUND=true` logs the intended payload instead of calling Viber |
| Real Viber UI behaviour (deep link from phone, group add, message rendering) | ❌ | Requires a tunneled dev bot — see Step 5 |

You can sign off on every box except the last with no Viber account whatsoever. The last one is a single 5-minute tunneled smoke test.

---

## Step 0 — Prereqs

- Postgres running for event-planner (the dev compose / supabase / whatever you use locally).
- A **real Clerk userId** that exists in your event-planner dev tenant. You can find it by signing into `localhost:3000` and reading it from Clerk's dashboard, or:
  ```bash
  echo "select id from clerk_users limit 5;" | psql ...   # (or query Clerk directly)
  ```
- `CRON_SECRET_KEY` matched between `~/dev/event-planner/.env` and `~/dev/sales-recon/.env`.

Export the values you'll reuse:

```bash
export CRON=<your CRON_SECRET_KEY>
export CLERK_USER=<a real Clerk userId, e.g. user_2abc...>
export VIBER_USER=test-viber-user-1
export WEBAPP=http://localhost:3000
export PROXY=http://localhost:8081
```

---

## Step 1 — event-planner stand-alone

Apply the migration and start the webapp:

```bash
cd ~/dev/event-planner
npx prisma migrate dev      # creates ViberLinkCode + ViberUser tables
npm run dev                  # http://localhost:3000
```

Sanity-check the back-end APIs directly (no UI involved):

```bash
# 1. Lookup an unlinked Viber user → { linked: false }
curl -s -X POST $WEBAPP/api/viber/lookup \
  -H "Authorization: Bearer $CRON" -H "Content-Type: application/json" \
  -d "{\"viberUserId\":\"$VIBER_USER\"}" | jq

# 2. Negative auth → 401
curl -s -X POST $WEBAPP/api/viber/lookup \
  -H "Content-Type: application/json" -d '{"viberUserId":"x"}' \
  -w '\nHTTP %{http_code}\n'

# 3. Generate a link code via the UI:
#    - Browser: $WEBAPP/account/link-viber (sign in first as $CLERK_USER)
#    - Click "Generate Viber Link"
#    - Copy the 10-char code
export CODE=<paste code here>

# 4. Redeem the code on behalf of the test Viber user
curl -s -X POST $WEBAPP/api/viber/link/redeem \
  -H "Authorization: Bearer $CRON" -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\",\"viberUserId\":\"$VIBER_USER\",\"viberName\":\"Test User\"}" | jq

# 5. Lookup again → { linked: true, clerkUserId, clerkName, role }
curl -s -X POST $WEBAPP/api/viber/lookup \
  -H "Authorization: Bearer $CRON" -H "Content-Type: application/json" \
  -d "{\"viberUserId\":\"$VIBER_USER\"}" | jq

# 6. Re-redeem same code → { error: "invalid_or_expired" }
curl -s -X POST $WEBAPP/api/viber/link/redeem \
  -H "Authorization: Bearer $CRON" -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\",\"viberUserId\":\"another\",\"viberName\":\"x\"}" | jq

# 7. Mint an action token for the linked Clerk user
curl -s -X POST $WEBAPP/api/intelligence/session-by-userid \
  -H "Authorization: Bearer $CRON" -H "Content-Type: application/json" \
  -d "{\"clerkUserId\":\"$CLERK_USER\"}" | jq
```

If all seven pass, the entire webapp side is proven without Viber.

---

## Step 2 — viber-proxy stand-alone (mock outbound)

Bring up viber-proxy in **mock mode** so it never tries to call Viber's `send_message`:

```bash
cd ~/dev/sales-recon

# In .env, add (or override) just for local:
#   VIBER_BOT_TOKEN=local-test-token
#   MOCK_VIBER_OUTBOUND=true
#   WEBAPP_URL=http://host.docker.internal:3000   (Mac/Win)
#   CRON_SECRET_KEY=<same as event-planner>

docker compose up -d --build viber-proxy
docker compose logs -f viber-proxy
```

In another shell:

```bash
curl -s $PROXY/healthz | jq
# → { "ok": true, "openclaw": true }
```

> **Note on `WEBAPP_URL` from inside the container:** on Linux, `host.docker.internal` doesn't resolve by default. Either add `extra_hosts: ["host.docker.internal:host-gateway"]` to the viber-proxy service in `docker-compose.override.yml`, or run event-planner in the same compose network.

---

## Step 3 — synthetic webhook driver

`local-test.sh` signs JSON payloads with `VIBER_BOT_TOKEN` (HMAC-SHA256 hex, exactly the format Viber uses) and POSTs them at `localhost:8081/viber/webhook`. The proxy can't tell the difference from a real Viber delivery.

Run:

```bash
cd ~/dev/sales-recon/viber-proxy/scripts
VIBER_BOT_TOKEN=local-test-token \
CRON_SECRET_KEY=$CRON \
CLERK_USER_ID=$CLERK_USER \
VIBER_USER_ID=$VIBER_USER \
  ./local-test.sh
```

Tests run, in order:

| # | Case | Expected |
|---|---|---|
| Preflight | `/healthz` reachable, webapp reachable, `$VIBER_USER_ID` linked | green checks |
| 1 | webhook with no `X-Viber-Content-Signature` header | **403** |
| 2 | valid signature, mutated body | **403** |
| 3 | `event: webhook` ping | **200**, no-op |
| 4 | DM `message` from unlinked sender | **200**, mock log shows `send_message` with link instructions to that user |
| 5 | DM `message` from linked sender | **200**, openclaw logs show `chat.send` with `sessionKey=user-<clerkUserId>`, mock log eventually shows the final reply text |
| 6 | replay step 5 with the same `message_token` | **200**, viber-proxy log shows `dedupe message_token …` (no second OpenClaw call) |
| 7 | group `message` (`chat_id` set) from linked sender | **200**, mock log shows outbound to `chat_id=…`, openclaw uses `sessionKey=viber-group-…`, message prefixed with `[from: <name>, role: <role>]` |
| 8 | group `message` from unlinked sender | **200**, mock log shows group reply with link URL — **no OpenClaw call** |
| 9 | `conversation_started` with no context | **200** with `{ type: "text", text: "Welcome…" }` in the response body |
| 10 | `conversation_started` with bogus context | **200** with "invalid/expired" text in the response body |
| 11 | `conversation_started` with real `LINK_CODE` (only if `LINK_CODE=…` exported) | **200** with success text; new `ViberUser` row created |

The script prints `Summary: N passed, 0 failed` and exits 0 on full success.

While the script runs, keep `docker compose logs -f viber-proxy sales-recon-openclaw` open in another window — most assertions are confirmed visually in the logs (the script mostly verifies status codes and response bodies; OpenClaw routing has to be checked by eye for now).

### What "linked test user" means

The script's preflight asserts that `$VIBER_USER_ID` is already linked to `$CLERK_USER_ID` in the `ViberUser` table. The simplest way to set that up is Step 1 #3–#4 above (generate a code in the UI, redeem it via curl). Once the row exists, you can re-run `local-test.sh` as many times as you want — link rows persist across runs.

---

## Step 4 — Failure modes worth confirming

After the happy-path script passes, deliberately break things to confirm error paths:

1. **Stop event-planner**, then re-run a DM message via `local-test.sh`. viber-proxy should reply (in mock log) with "Could not establish a secure session" rather than calling OpenClaw.
2. **Wrong CRON_SECRET_KEY** in viber-proxy's `.env`: should produce the same "Could not establish a secure session" message.
3. **Stop OpenClaw** (`docker compose stop sales-recon-openclaw`): linked DM should reply with "Not connected to agent. Please try again." (from `OpenClawClient.sendMessage` connection check).
4. **Replay an *expired* link code** (run a redeem >10 min after `link/create`): should return `invalid_or_expired`.

---

## Step 5 — One tunneled smoke test (optional, only when ready)

This is the **only** step that needs a real Viber bot. Use a **separate dev bot** so production isn't affected.

1. Create a second free bot at <https://partners.viber.com/account/create-bot-account>. Save its token.
2. Tunnel:
   ```bash
   ngrok http 8081
   # or: cloudflared tunnel --url http://localhost:8081
   ```
3. Switch viber-proxy out of mock mode:
   ```bash
   # in .env:
   VIBER_BOT_TOKEN=<dev bot token>
   MOCK_VIBER_OUTBOUND=false   # or remove the line
   docker compose up -d --build viber-proxy
   ```
4. Register the dev webhook:
   ```bash
   VIBER_BOT_TOKEN=<dev token> \
   VIBER_WEBHOOK_URL=https://<tunnel>.ngrok-free.app/viber/webhook \
     ./set-webhook.sh
   ```
5. On a phone with Viber, follow the dev bot. Generate a code at `localhost:3000/account/link-viber` (use a host-reachable URL or expose ngrok for the webapp too if you're testing from a non-LAN device). Redeem via the bot. Send a DM. Confirm the reply renders in Viber.

That's the only thing you can't validate with `local-test.sh`.

---

## What the script does NOT cover (yet)

- Outbound message rendering in the actual Viber app (markdown, chunk boundaries, line breaks). Visual only — you have to see it on a phone.
- Viber community admin permissions — adding the bot to a community is a Viber-app workflow.
- Long-running OpenClaw runs (>30s) — script validates the webhook returns 200 immediately, but the eventual final text only shows in logs after the agent finishes.
- Concurrent webhooks under load. The dedupe LRU is sized at 1000; bursting more than that simultaneously with duplicate `message_token`s would let duplicates through. Not a real production concern but flagged here.

These are explicitly out of scope for local testing — defer to the Step 5 smoke test or to production observation.
