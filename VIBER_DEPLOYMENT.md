# Viber Integration — Production Deployment Plan

## Context
The Viber integration is feature-complete on the `viber` branch of `event-planner` (with migration `20260510175637_add_viber_models`) and the `gbrain2` branch of `sales-recon` (with the new `viber-proxy` service). Both repos deploy to a single Hetzner VPS via `deploy-prod.sh`. This plan walks through the **one-time setup** in the Viber Partner Console, the **env vars** to add to each repo's prod `.env`, and the **deploy order** that avoids dead-ends (e.g. registering a webhook against a URL that's not live yet, or letting `viber-proxy` boot against a DB that lacks the Viber tables).

Public surfaces:
- `viber.maximh.us` → `viber-proxy:8081` (TLS via Traefik on sales-recon stack)
- `events.maximh.us` → event-planner (Traefik, already routing)
- `chat.maximh.us`, `control.maximh.us` → unchanged

---

## Step 1 — Create the Viber Public Account (Bot)

Viber bots are called "Public Accounts" (PAs). One PA = one webhook = one auth token.

1. **Sign up / sign in** at https://partners.viber.com/ using a Viber-registered phone number. You will need the Viber mobile app on that phone to receive an SMS/in-app verification code.
2. Open **Create Bot Account** (or "Create Public Account") in the Partners portal.
3. Fill the form:
   - **Account name** → e.g. `Sales-Recon` (this is what users see in their Viber chat list; must match the `VIBER_BOT_NAME` env var below).
   - **URI** → e.g. `sales-recon` (this is the `chatURI`; **must match `VIBER_BOT_URI`** in event-planner's `.env` because the deep-link is `viber://pa?chatURI=<URI>&context=<CODE>`). Lowercase letters, digits and hyphens only; this is permanent.
   - **Category / Subcategory / Language** → pick whatever applies.
   - **Description** → short description shown on the bot's profile page.
   - **Logo / icon** → a 720×720 square PNG/JPG. After upload Viber will give you a public URL — copy it; that's your `VIBER_BOT_AVATAR_URL`.
4. Submit. You'll be taken to the bot's admin page.
5. On the admin page, copy the **Authentication token** (a long string starting with digits/letters). This is your `VIBER_BOT_TOKEN`. **Treat this as a secret** — anyone with it can impersonate the bot.

> **Tip:** keep this browser tab open until the end of deployment — you may want to copy the chatURI / token again, and Viber doesn't re-display the token (you'd have to reset it).

---

## Step 2 — Confirm / set env vars

### 2a. `sales-recon/.env` on the VPS

SSH to the server and append/confirm the following keys. Names that already exist (e.g. `OPENCLAW_GATEWAY_TOKEN`, `CRON_SECRET_KEY`, `WEBAPP_URL`) **must not be changed** — viber-proxy reuses them.

```bash
# Already-present, confirm values:
OPENCLAW_GATEWAY_TOKEN=...        # unchanged
CRON_SECRET_KEY=...               # MUST be identical to event-planner's CRON_SECRET_KEY
WEBAPP_URL=https://events.maximh.us

# New, add for viber-proxy:
VIBER_BOT_TOKEN=<token from Step 1.5>
VIBER_BOT_NAME=Sales-Recon                              # must match Step 1.3 name (case-insensitive for group /@mentions)
VIBER_BOT_AVATAR_URL=<logo URL from Step 1.3>           # optional but recommended
VIBER_BOT_URI=sales-recon                               # the chatURI from Step 1.3 (not strictly needed by viber-proxy today, but harmless to set so both halves of .env agree)
```

Optional debug knobs (leave unset / `false` in prod):
```bash
# DEBUG=true                  # logs first 500 chars of every webhook body
# MOCK_VIBER_OUTBOUND=true    # only for local — disables real outbound Viber API calls
```

### 2b. `event-planner/.env` on the VPS

```bash
# Already-present, confirm values:
CRON_SECRET_KEY=...               # MUST equal sales-recon's CRON_SECRET_KEY
DATABASE_URL=...                  # existing Postgres
CLERK_SECRET_KEY=...              # existing

# New for the Viber linking flow:
VIBER_BOT_URI=sales-recon         # MUST match the URI from Step 1.3 exactly
```

> **Two consistency checks before moving on:**
> 1. `grep CRON_SECRET_KEY` in both `.env` files returns the **same value**. Mismatch → every viber message will get a 401 from `/api/viber/lookup`.
> 2. `VIBER_BOT_URI` in event-planner's `.env` matches the chatURI shown on the bot's Partners page. Mismatch → the QR/deep-link will open Viber but to a non-existent bot.

---

## Step 3 — Merge & deploy event-planner first

`viber-proxy` calls four event-planner endpoints (`/api/viber/lookup`, `/api/viber/link/create`, `/api/viber/link/redeem`, `/api/intelligence/session-by-userid`) and the linking page `/account/link-viber`. These must be live **before** the first Viber webhook fires, otherwise users get 404s during account linking. Deploy event-planner first.

On your dev machine:
```bash
cd /Users/eusholli/dev/event-planner
git status                              # commit pending changes to the 4 viber files + proxy.ts
git checkout main
git merge viber                         # or open a PR and merge via GitHub
git push origin main
```

On the VPS:
```bash
cd /path/to/event-planner
git pull
./deploy-prod.sh
```

The migration `20260510175637_add_viber_models` (creates `ViberLinkCode` and `ViberUser` tables) will run as part of `deploy-prod.sh` — confirm it does by tailing the deploy output for `Applying migration` lines.

**Smoke-test event-planner before continuing:**
```bash
# From your laptop:
curl -i -X POST https://events.maximh.us/api/viber/lookup \
  -H "Authorization: Bearer $CRON_SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"viberUserId":"smoke-test"}'
# Expect: HTTP 200, body {"linked":false}
```

A 401 means `CRON_SECRET_KEY` is wrong; a 500 means the migration didn't apply (check the Prisma client). Fix before moving on.

---

## Step 4 — Merge & deploy sales-recon (with viber-proxy)

On your dev machine:
```bash
cd /Users/eusholli/dev/sales-recon
git status                              # commit viber-proxy/index.js + openclaw-data/openclaw.json
git checkout main
git merge gbrain2
git push origin main
```

On the VPS:
```bash
cd /path/to/sales-recon
git pull
./deploy-prod.sh
```

`deploy-prod.sh` runs `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`, which builds the new `viber-proxy` image and brings it up behind Traefik with the `viber.maximh.us` labels.

**Verify the container is healthy:**
```bash
docker compose ps                       # sales-recon-viber-proxy should be Up
docker compose logs -f viber-proxy      # look for: "viber-proxy listening on :8081"
                                        #          "device.json loaded, deviceId=..."
                                        #          "openclaw connect.ok role=operator"
```

**Verify Traefik routing & TLS:**
```bash
# From your laptop:
curl -i https://viber.maximh.us/health  # if the proxy exposes /health; otherwise:
curl -i https://viber.maximh.us/        # expect 404 from express (means TLS + routing work)
```

If you get a Traefik 404, the host rule didn't pick up — `docker compose logs traefik | grep viber`.

> **device.json caveat:** on first boot, `viber-proxy/data/device.json` is auto-generated (Ed25519 keypair). Back it up off-server immediately: `scp root@vps:/path/to/sales-recon/viber-proxy/data/device.json ~/secrets/viber-proxy-device.json`. Losing it orphans the device registration in OpenClaw.

---

## Step 5 — Register the webhook with Viber

The webhook URL **must** be HTTPS and reachable from the public internet — that's why Step 4 comes before Step 5. Run this **on the VPS** (so the env vars are already loaded):

```bash
cd /path/to/sales-recon
set -a; source .env; set +a              # loads VIBER_BOT_TOKEN into the shell
export VIBER_WEBHOOK_URL=https://viber.maximh.us/viber/webhook
./viber-proxy/scripts/set-webhook.sh
```

Expected response (JSON):
```json
{"status":0,"status_message":"ok","event_types":["message","conversation_started","subscribed","unsubscribed","delivered","failed"],"chat_hostname":"..."}
```

Non-zero `status` → most common causes:
- `1` = invalid auth token (re-check `VIBER_BOT_TOKEN`)
- `2` = invalid URL (must be HTTPS with a public, trusted cert — verify Step 4 curl)
- `3` = webhook verification failed (Viber sent a probe and didn't get HTTP 200; check `docker logs viber-proxy`)

> Re-running the script is safe — Viber treats it as a rebind, not a duplicate registration.

---

## Step 6 — End-to-end smoke test

1. On your phone, open Viber. Tap the **Search** icon and search for the bot URI (`sales-recon`). The PA's profile card should appear with the avatar from Step 1.
2. Tap **Chat** / **Subscribe**. The first message Viber sends is `conversation_started` (no context) → the bot should reply with a "Welcome — link your account at https://events.maximh.us/account/link-viber" message.
3. On a desktop browser logged into Clerk, visit `https://events.maximh.us/account/link-viber`. Click **Generate Viber Link** → a QR code + deep link appear.
4. On your phone, scan the QR. Viber should open the bot with a `conversation_started` event carrying `context=<CODE>`. The bot replies **"Account linked for <your name>!"**.
5. From the phone, send the bot: `Tell me about Anthropic`. Within ~5–60s the bot should reply with the structured intel report markdown.

Tail logs in parallel on the VPS to watch the flow:
```bash
docker compose logs -f viber-proxy openclaw
```

Expected log sequence per message:
- `webhook event=message message_token=...`
- `lookup viberUserId=... → clerkUserId=...`
- `session-by-userid → role=user`
- `openclaw chat.send sessionKey=user-<clerkUserId>`
- `openclaw chat.final` then `viber send_message len=...`

---

## Step 7 — Post-deploy hygiene

- **Back up `device.json`** (Step 4 reminder) — required to restore the same device identity if the VPS is rebuilt.
- **Confirm cron** still works: `python3 event-planner-cron.py` from the sales-recon dir if it was already scheduled; viber-proxy doesn't add any new cron requirements.
- **Watch billing / rate limits** — Viber PAs have a soft limit on outbound messages; if you hit it, `viber-proxy` will log a non-zero status from `chatapi.viber.com/pa/send_message`.
- **Document the bot token** in your secrets vault alongside the chatURI so a future operator can rotate without recreating the PA.

---

## Verification checklist (end-to-end, in one place)

- [ ] `partners.viber.com` shows the bot account with status "Active"
- [ ] `grep -E 'CRON_SECRET_KEY|VIBER_BOT_URI' .env` matches between both repos on the VPS
- [ ] `curl https://events.maximh.us/api/viber/lookup` returns `{"linked":false}` for an unknown user (Bearer auth working)
- [ ] `docker compose ps` shows `sales-recon-viber-proxy` Up
- [ ] `curl -i https://viber.maximh.us/` returns a response from the proxy (not Traefik default)
- [ ] `set_webhook` returned `status: 0`
- [ ] Subscribing to the bot on Viber gets a welcome reply
- [ ] `/account/link-viber` produces a working QR that links a real account
- [ ] A linked user gets a structured-report reply from the bot
- [ ] `viber-proxy/data/device.json` is backed up off the VPS

---

## Files touched (reference)

- `sales-recon/viber-proxy/` (new service, full stack — index.js, openclaw-client.js, device.js, signature.js, viber-client.js, scripts/set-webhook.sh)
- `sales-recon/docker-compose.yml`, `docker-compose.override.yml`, `docker-compose.prod.yml` (viber-proxy service + Traefik labels)
- `event-planner/prisma/migrations/20260510175637_add_viber_models/` (DB migration)
- `event-planner/app/api/viber/{lookup,link/create,link/redeem}/route.ts`
- `event-planner/app/api/intelligence/session-by-userid/route.ts`
- `event-planner/app/account/link-viber/page.tsx`
- `event-planner/proxy.ts` (route wiring)
