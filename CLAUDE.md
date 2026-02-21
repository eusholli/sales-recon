# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sales-Recon is a 3-container Docker stack that provides AI-powered intelligence reports (company/person/event research) via a WebSocket-based chat interface. The system routes authenticated browser WebSocket connections through a proxy into an OpenClaw AI gateway which uses MCP skills (web scraping, search) to generate reports.

## Architecture

### Container Stack

```
Browser → Traefik (global) → ws-proxy → OpenClaw (AI gateway)
                                              ↓
                                    MCP Skills: Crawl4AI, Tavily
```

**`sales-recon-openclaw`** (`Dockerfile`, `skills/`, `scripts/`)
- Base image: `ghcr.io/openclaw/openclaw:latest`
- Extended with Python, Playwright/Chromium, and Crawl4AI for web scraping
- On startup, `scripts/docker-entrypoint.release.sh` registers MCP servers via `mcporter`:
  - `crawl4ai`: Python MCP server (`skills/crawl4ai-service/server.py`) using FastMCP + Crawl4AI
  - `tavily`: Remote HTTP MCP server (if `TAVILY_API_KEY` is set)
- Config persisted to `OPENCLAW_CONFIG_DIR` volume; golden-image templates: `openclaw-golden-image.json` and `mcporter-golden-image.json`

**`ws-proxy`** (`ws-proxy/`)
- Node.js WebSocket bridge (ESM, port 8080)
- Authenticates browser clients using Clerk JWT (`@clerk/backend` `verifyToken`)
- Maintains a single persistent WebSocket connection to OpenClaw, multiplexed across browser sessions
- Device identity (Ed25519 keypair) stored in `ws-proxy/data/device.identity.json` (gitignored, **must be backed up** — if lost, the OpenClaw gateway will reject the proxy)
- Performs challenge-response device auth handshake with OpenClaw on connect

**`traefik-global/`** — Global reverse proxy, runs as a **separate independent stack** on the VPS (not part of this project's `docker-compose.yml`). Attaches to the external `webproxy` Docker network.

**`test-ui/`** — Next.js 16 + Tailwind + Clerk frontend. Uses the `useOpenClaw` hook (`app/hooks/useOpenClaw.ts`) to manage a WebSocket connection to ws-proxy. Not containerized; run locally for development.

### Docker Compose File Strategy

| File | Purpose | Usage |
|---|---|---|
| `docker-compose.yml` | Base config (no Traefik routing labels) | Always used |
| `docker-compose.override.yml` | Local dev overrides (port 8080 exposed, local routing) | Auto-merged by Docker Compose when present (gitignored) |
| `docker-compose.prod.yml` | Production labels (TLS, real domain, `webproxy` network) | Explicitly merged for production |

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
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` — Clerk auth (used by ws-proxy and test-ui)
- `TAVILY_API_KEY` — Enables Tavily web search MCP skill
- AI API keys: `XAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, etc.

## Key Implementation Details

- **ws-proxy session routing**: Each browser connection gets a unique `sessionKey` (`browser-<uuid>`). OpenClaw returns events with a prefixed session key (e.g., `agent:main:browser-...`); ws-proxy strips the prefix by taking the last `:` segment.
- **Streaming**: OpenClaw sends `event: agent` messages with `stream: 'assistant'` deltas; ws-proxy forwards these as `{type: 'chunk'}` to the browser. `event: chat` with `state: 'final'` triggers `{type: 'final'}`.
- **Message enrichment**: `sendToOpenClaw` prepends entity context: `"Generate an intelligence report for {entityType} '{entityName}'. User request: {message}"`.
- **MCP skill auto-registration**: The entrypoint script runs on every container start and re-registers MCP servers (idempotent via mcporter).

## Production Deployment Notes

- Recommended server: Hetzner CX32 (3 vCPU, 8GB RAM) — Chromium/Playwright requires 8GB to avoid OOM kills
- `ws-proxy/data/device.identity.json` must be preserved across deployments; include in backup strategy
- `docker-compose.override.yml` is gitignored — never present on the production server
- Use `docker compose -f docker-compose.yml -f docker-compose.prod.yml` explicitly on the server
- Hetzner cloud firewall: allow inbound TCP 22 (your IP only), 80, 443; drop all else
