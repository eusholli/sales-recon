# Viber Setup Guide

This guide covers everything needed to make the Sales-Recon Viber bot work in production:

1. **Operator setup** — what an admin does once to register the bot, configure DNS/env vars, and deploy.
2. **End-user setup** — what each sales person does to link their Viber account to event-planner so the bot recognises them.

Architecture recap: the `viber-proxy` container (port 8081, routed via `viber.maximh.us`) accepts Viber webhook deliveries, looks up the Viber sender against the event-planner database (`/api/viber/lookup`), mints an action token for that Clerk user, and dispatches the chat to OpenClaw on the same `sessionKey` the user gets in the browser (`user-<clerkUserId>`) — so threads merge across surfaces. Group/community chats use `viber-group-<chatId>`.

---

## Part 1 — Operator setup (one-time)

### 1.1 Create the Viber Public Account

1. Sign in at <https://partners.viber.com/account/create-bot-account>.
2. Click **Create Bot Account**. Choose a **URI** (this becomes your bot's `chatURI`, e.g. `sales-recon`) — this is what end users see in `viber://pa?chatURI=…` deep links. Save it as `VIBER_BOT_URI`.
3. Set a name and avatar. These are shown in chats and on the link page; they correspond to the `VIBER_BOT_NAME` / `VIBER_BOT_AVATAR_URL` env vars.
4. After the account is created, copy the **Authentication Token** from the bot's settings page. Save it as `VIBER_BOT_TOKEN`.

> Viber requires the webhook to terminate TLS with a public CA certificate. Let's Encrypt (used by our Traefik instance) is accepted. Self-signed certs will be rejected.

### 1.2 DNS

Point `viber.maximh.us` (A/AAAA record) at the same VPS IP as `chat.maximh.us`. Traefik already has the routing in `docker-compose.prod.yml`; Let's Encrypt will issue the cert on first request.

### 1.3 Env vars

Add to `/path/to/sales-recon/.env` on the production host:

```dotenv
VIBER_BOT_TOKEN=<token from 1.1>
VIBER_BOT_URI=<URI slug from 1.1>            # e.g. sales-recon
VIBER_BOT_NAME=Sales-Recon
VIBER_BOT_AVATAR_URL=https://…/avatar.png    # optional
WEBAPP_URL=https://events.maximh.us          # public URL of the event-planner webapp
CRON_SECRET_KEY=<existing shared secret>     # already used for cron + ws-proxy
```

Mirror the same five `VIBER_*` and `WEBAPP_URL` / `CRON_SECRET_KEY` values into the **event-planner** `.env` (so its `/api/viber/*` routes can validate the bearer and build deep links).

### 1.4 Deploy

```bash
# In ~/dev/event-planner — picks up the new Prisma models + /api/viber/* routes
./deploy-prod.sh

# In ~/dev/sales-recon — builds and starts the viber-proxy container
./deploy-prod.sh
```

`prisma migrate deploy` runs as part of event-planner's build, so the `ViberLinkCode` and `ViberUser` tables are created automatically. The viber-proxy container generates its own Ed25519 device identity at `viber-proxy/data/device.json` on first boot — back this file up the same way you back up `ws-proxy/data/device.json`.

### 1.5 Register the webhook with Viber

Once `https://viber.maximh.us/healthz` returns `{"ok": true, ...}`, point Viber at it:

```bash
cd ~/dev/sales-recon/viber-proxy
VIBER_BOT_TOKEN=<token> \
VIBER_WEBHOOK_URL=https://viber.maximh.us/viber/webhook \
  ./scripts/set-webhook.sh
```

Expected response: `{"status":0,"status_message":"ok","event_types":[...]}`. The script is idempotent — re-run it any time the URL or event list changes.

### 1.6 Smoke test

1. Open Viber on a phone, search for the bot URI, follow it.
2. Send the bot a message ("Generate intel on Acme Corp"). You'll get a "Hi! To use this bot, link your account first…" reply since you're not yet linked. That's the expected unauthenticated path.
3. Tail logs: `docker compose logs -f viber-proxy` — you should see `signature` verification pass and `link.lookup` show `linked: false`.

---

## Part 2 — End-user setup (per sales person)

Each user does this **once** from any device. After linking, the bot recognises them in DMs and in any Viber Community/Group the bot is added to.

### 2.1 Sign in to event-planner

Go to `https://events.maximh.us` and sign in with Clerk (Google/email/etc.). You must already have an event-planner account; if you don't, request one from your admin.

### 2.2 Open the link page

Navigate to `https://events.maximh.us/account/link-viber`. You'll see a **Generate Viber Link** button.

### 2.3 Generate a link code

Click **Generate Viber Link**. The page shows:

- A 10-character code (valid for **10 minutes**, single-use).
- An **Open Viber** button — on mobile this opens Viber directly to the bot chat with the code attached.
- A **QR code** — scan this from another device's Viber app to do the same thing without typing.

### 2.4 Open Viber and confirm

- **On phone:** tap **Open Viber** (or scan the QR). Viber opens the bot's chat. The bot replies `Account linked for <Your Name>! You can now ask me for intel anytime.`
- **On desktop:** scan the QR with your phone's Viber, then return — same confirmation appears in chat.

If you instead see `That link code is invalid or expired`, the 10-minute window passed or the code was already used. Just click **Generate Viber Link** again.

### 2.5 Use the bot

In any chat with the bot — DM **or** any Viber Community where an admin has added the bot — send a query like:

```
Generate intel on Acme Corp
```

You'll see `Working on it…` within ~1 second, then the full intelligence report when ready (split into multiple messages if it exceeds Viber's 7000-character limit).

DMs share the same chat history as your browser session at `events.maximh.us` — anything you ask the bot via Viber appears in your web chat too.

---

## Part 3 — Adding the bot to a Viber Community / Group

Any linked event-planner user can add the bot to their own Viber Communities (sales team groups, customer threads, etc.):

1. Open the community in Viber → tap the community name → **Add Members** → search for the bot URI → add it.
2. Once added, anyone in the community can mention the bot or post a query and it will reply in the group.
3. **Unlinked posters** in the group get a single reply pointing them at `https://events.maximh.us/account/link-viber`. Their messages are not sent to the AI.
4. **Linked posters** see their messages routed to OpenClaw with attribution (`[from: Jane Doe, role: user] …`). Group threads use a shared `sessionKey` (`viber-group-<chatId>`), so the agent has continuity within that group.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Webhook returns 403 | Signature mismatch (wrong `VIBER_BOT_TOKEN` or proxy stripping body) | Confirm `.env` token matches the one in Viber's bot settings; ensure Traefik passes raw body unchanged |
| `set-webhook.sh` returns `failed` status | URL not publicly reachable on HTTPS | Check `https://viber.maximh.us/healthz` from outside the network; check Traefik cert issuance |
| Bot replies in DM but not in groups | Viber community admin permissions | The community admin must explicitly add the bot; community-wide messaging permissions must be enabled |
| `Could not establish a secure session` | event-planner unreachable or `CRON_SECRET_KEY` mismatch | Compare `CRON_SECRET_KEY` between the two `.env` files; check `WEBAPP_URL` is reachable from the viber-proxy container |
| Chat history doesn't merge with browser | `sessionKey` mismatch — check the user is signed into the **same** Clerk account on the web | DMs key on `user-<clerkUserId>`; both surfaces must resolve to the same Clerk userId |
| Link code says "invalid or expired" immediately | System clock drift or code already consumed | Re-generate; codes are single-use with a 10-minute TTL |

Useful log commands:

```bash
docker compose logs -f viber-proxy           # webhook + OpenClaw activity
docker compose logs -f sales-recon-openclaw  # AI gateway side
```

To inspect link rows directly:

```bash
docker exec -it event-planner-postgres psql -U <user> -d <db> \
  -c 'SELECT * FROM "ViberUser" ORDER BY "linkedAt" DESC LIMIT 10;'
```

---

## Reference: env vars at a glance

| Var | Where | Purpose |
|---|---|---|
| `VIBER_BOT_TOKEN` | sales-recon `.env`, event-planner `.env` (only if you ever call Viber from the webapp directly — currently not needed) | Bot auth header for outbound `send_message` calls and webhook signature verification |
| `VIBER_BOT_URI` | event-planner `.env` | Slug used to build `viber://pa?chatURI=<URI>&context=<code>` deep links |
| `VIBER_BOT_NAME` | sales-recon `.env` | Sender name on outbound Viber messages |
| `VIBER_BOT_AVATAR_URL` | sales-recon `.env` | Sender avatar on outbound Viber messages |
| `WEBAPP_URL` | sales-recon `.env` | Public URL viber-proxy uses to call event-planner APIs |
| `CRON_SECRET_KEY` | both | Bearer secret on `/api/viber/*` and `/api/intelligence/session-by-userid` |
