# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sales-Recon is a 3-container Docker stack that provides AI-powered intelligence reports (company/person/event research) via a WebSocket-based chat interface. The system routes authenticated browser WebSocket connections through a proxy into an OpenClaw AI gateway which uses MCP skills (web scraping, search) to generate reports.

## Architecture

### Container Stack

```
Browser → Traefik (prod only) → ws-proxy → OpenClaw (AI gateway)
              ↓                 ↓
      control.maximh.us   chat.maximh.us
```

**`sales-recon-openclaw`** (`Dockerfile`, `skills/`, `scripts/`)
- Base image: `ghcr.io/openclaw/openclaw:latest`
- Extended with Python, Playwright/Chromium, and Crawl4AI for web scraping
- On startup, `scripts/docker-entrypoint.release.sh` registers MCP servers via `mcporter`
- Built-in Control UI exposed on port 50045, routed via `control.maximh.us` in prod

**`ws-proxy`** (`ws-proxy/`)
- Node.js WebSocket bridge (ESM, port 8080)
- Authenticates browser clients using Clerk JWT (`@clerk/backend` `verifyToken`). Supports multiple Clerk authentication instances via comma-separated `WS_PROXY_CLERK_SECRET_KEYS`.
- Routes browser sessions to OpenClaw via `ws://openclaw:50045` with token-only auth
- Role: `operator` (using operator scopes for chat messages)
- Uses Ed25519 device identity (`ws-proxy/data/device.json`) for device auth alongside `OPENCLAW_TOKEN`

**`viber-proxy`** (`viber-proxy/`)
- Node.js HTTP webhook bridge for the Viber Bot API (ESM, port 8081).
- Verifies Viber webhook signatures (HMAC-SHA256 of raw body using `VIBER_BOT_TOKEN`).
- Maps Viber users to Clerk users via the event-planner webapp (`/api/viber/lookup`); unlinked users get a reply pointing at `/account/link-viber` to link their account.
- Mints action tokens server-side via `/api/intelligence/session-by-userid` (Bearer `CRON_SECRET_KEY`) and dispatches messages to OpenClaw using the same `sessionKey` convention as ws-proxy: DMs use `user-<clerkUserId>` (so threads merge with the browser surface), groups/communities use `viber-group-<chatId>`.
- Uses its own Ed25519 device identity (`viber-proxy/data/device.json`) for OpenClaw v3 handshake.
- Routed via `viber.maximh.us` in prod.
- Bootstrap: register the public webhook URL once via `viber-proxy/scripts/set-webhook.sh` (requires `VIBER_BOT_TOKEN` and `VIBER_WEBHOOK_URL`).

**`traefik-global/`** — Global reverse proxy, runs as a separate stack.

**`test-ui/`** — Next.js frontend. Connects to `ws://gateway.local:8080` (local) or `wss://chat.maximh.us` (prod).

### Docker Compose File Strategy

| File | Purpose | Usage |
|---|---|---|
| `docker-compose.yml` | Base config | Always used |
| `docker-compose.override.yml` | Local dev: `50045:50045` (Control UI), `8080:8080` (ws-proxy), `8081:8081` (viber-proxy) | Auto-merged locally |
| `docker-compose.prod.yml` | Traefik labels for `control.maximh.us`, `chat.maximh.us`, `viber.maximh.us` | Merge for prod |

## Common Commands

### Docker Stack

```bash
# Validate merged config (local)
docker compose config

# Local development (auto-merges docker-compose.override.yml)
docker compose up -d
docker compose logs -f

# Production deployment
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# Rebuild a single service
docker compose build sales-recon-openclaw
docker compose up -d --no-deps sales-recon-openclaw

# Check status
docker compose ps
docker stats --no-stream

# Shell access
docker exec -it sales-recon-openclaw bash
docker exec -it sales-recon-ws-proxy sh
```

### Global Traefik (run once on VPS, from `traefik-global/`)

```bash
docker network create webproxy
cd traefik-global && docker compose up -d
```

### test-ui (Next.js frontend)

```bash
cd test-ui
npm install
npm run dev     # Development server
npm run build   # Production build
npm run lint    # ESLint
```

### Production Deployment Script

```bash
# Convenience wrapper for prod deployment (runs from repo root)
./deploy-prod.sh
```

### Market Intelligence Cron Jobs

```bash
# Register/refresh scheduled intelligence runs (Tuesday + Thursday 06:00 CT)
# Requires CRON_EVENT_PLANNER_DNS and CRON_SECRET_KEY in .env
python3 event-planner-cron.py
```

Registers cron jobs inside the running `sales-recon-openclaw` container via `openclaw.mjs cron add`. Jobs are idempotent — re-running removes old jobs by name prefix before re-adding.

### OpenClaw / MCPorter (inside container)

```bash
# List MCP servers
docker exec -it sales-recon-openclaw npx mcporter config list

# OpenClaw health check
docker exec sales-recon-openclaw node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

## Environment Variables

Key variables required in `.env` (gitignored):
- `OPENCLAW_GATEWAY_TOKEN` — Shared secret between ws-proxy and OpenClaw
- `OPENCLAW_CONFIG_DIR` — Host path for persistent OpenClaw config volume
- `OPENCLAW_WORKSPACE_DIR` — Host path for persistent workspace volume
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` — Clerk auth (used by test-ui and ws-proxy)
- `WS_PROXY_CLERK_SECRET_KEYS` — Comma-separated list of additional Clerk secret keys (used by ws-proxy to support multiple auths)
- `TAVILY_API_KEY` — Enables Tavily web search MCP skill
- `CRON_EVENT_PLANNER_DNS` — DNS/URL for the event planner endpoint; enables cron job registration in `deploy-prod.sh` and `event-planner-cron.py`
- `CRON_SECRET_KEY` — Secret key passed to event planner cron jobs for authenticated requests; also used by viber-proxy as the Bearer token for `/api/viber/*` and `/api/intelligence/session-by-userid`
- `WEBAPP_URL` — Public URL of the event-planner webapp (e.g. `https://events.maximh.us`); used by viber-proxy and ws-proxy
- `VIBER_BOT_TOKEN` — Auth token issued by Viber when the Public Account is created
- `VIBER_BOT_NAME` / `VIBER_BOT_AVATAR_URL` — Sender identity attached to outbound Viber messages
- `VIBER_BOT_URI` — Bot's `chatURI` slug; used by event-planner to build `viber://pa?chatURI=…&context=…` deep links on `/account/link-viber`
- AI API keys: `XAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, etc.

## Key Implementation Details

- **ws-proxy session routing**: Each browser connection gets a unique `sessionKey` (`browser-<uuid>`). OpenClaw returns events with a prefixed session key (e.g., `agent:main:browser-...`); ws-proxy strips the prefix by taking the last `:` segment.
- **Streaming**: OpenClaw sends `event: agent` messages with `stream: 'assistant'` deltas; ws-proxy forwards these as `{type: 'chunk'}` to the browser. `event: chat` with `state: 'final'` triggers `{type: 'final'}`.
- **Message enrichment**: `sendToOpenClaw` prepends entity context: `"Generate an intelligence report for {entityType} '{entityName}'. User request: {message}"`.
- **MCP skill auto-registration**: The entrypoint script runs on every container start and re-registers MCP servers (idempotent via mcporter).

## Production Deployment Notes

- Recommended server: Hetzner CX32 (3 vCPU, 8GB RAM) — Chromium/Playwright requires 8GB to avoid OOM kills
- `ws-proxy/data/device.json` contains the Ed25519 private key — never commit to git. Back it up securely outside the repo (e.g., encrypted secret store). If lost, a new keypair is auto-generated but the old device registration in OpenClaw will be orphaned.
- `docker-compose.override.yml` is gitignored — never present on the production server
- Use `docker compose -f docker-compose.yml -f docker-compose.prod.yml` explicitly on the server
- Hetzner cloud firewall: allow inbound TCP 22 (your IP only), 80, 443; drop all else

## Expert Best Practice Rules

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
