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

**`traefik-global/`** — Global reverse proxy, runs as a separate stack.

**`test-ui/`** — Next.js frontend. Connects to `ws://gateway.local:8080` (local) or `wss://chat.maximh.us` (prod).

### Docker Compose File Strategy

| File | Purpose | Usage |
|---|---|---|
| `docker-compose.yml` | Base config | Always used |
| `docker-compose.override.yml` | Local dev: `50045:50045` (Control UI) & `8080:8080` (ws-proxy) | Auto-merged locally |
| `docker-compose.prod.yml` | Traefik labels for `control.maximh.us` and `chat.maximh.us` | Merge for prod |

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
- `CRON_SECRET_KEY` — Secret key passed to event planner cron jobs for authenticated requests
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
