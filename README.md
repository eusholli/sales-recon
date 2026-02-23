# Sales-Recon

AI-powered intelligence reports for companies, people, and events — delivered through a real-time WebSocket chat interface.

Sales-Recon is a Dockerized stack that routes authenticated browser connections through a WebSocket proxy into an [OpenClaw](https://github.com/openclaw/openclaw) AI gateway. The gateway leverages MCP skills (web scraping via Crawl4AI, search via Tavily) to research targets and generate structured reports.

## Architecture

```
┌──────────┐      ┌──────────────────┐      ┌──────────────────────┐
│ Browser  │─────▸│    ws-proxy       │─────▸│  OpenClaw Gateway    │
│ (test-ui)│ WSS  │ (Node.js, :8080)  │  WS  │  (:50045)            │
└──────────┘      └──────────────────┘      │                      │
                         │                  │  ┌────────────────┐  │
                    Clerk JWT               │  │ Crawl4AI (MCP) │  │
                    verification            │  │ Tavily  (MCP)  │  │
                                            │  └────────────────┘  │
                                            └──────────────────────┘
                                                      │
                                              Traefik (prod only)
                                            control.maximh.us
                                            chat.maximh.us
```

### Services

| Service | Description |
|---|---|
| **sales-recon-openclaw** | Extended OpenClaw image with Python, Playwright/Chromium, and Crawl4AI for web scraping. Runs the AI gateway on port 50045. |
| **ws-proxy** | Node.js WebSocket bridge (ESM, port 8080). Authenticates browser clients via Clerk JWT, then proxies messages to OpenClaw using a shared gateway token. |
| **test-ui** | Next.js 16 frontend with Clerk auth. Connects to `ws://gateway.local:8080` locally or `wss://chat.maximh.us` in production. |
| **traefik-global** | Reverse proxy (separate stack). Handles TLS termination and routing for `control.maximh.us` and `chat.maximh.us`. |

### Docker Compose Strategy

| File | Purpose |
|---|---|
| `docker-compose.yml` | Base service definitions — always used |
| `docker-compose.override.yml` | Local dev port mappings (`50045`, `8080`) — auto-merged, gitignored |
| `docker-compose.prod.yml` | Traefik labels for production routing and TLS |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose v2+
- [Node.js](https://nodejs.org/) 20+ (for local `test-ui` development)
- API keys (see [Environment Variables](#environment-variables))

## Getting Started

### 1. Clone & configure

```bash
git clone <repo-url> && cd sales-recon
cp .env.example .env   # then fill in your API keys
```

### 2. Start the stack (local development)

```bash
# Builds and starts openclaw + ws-proxy (override file auto-merges)
docker compose up -d --build

# Verify containers are running
docker compose ps
```

### 3. Run the frontend

```bash
cd test-ui
npm install
npm run dev
```

The chat UI will be available at `http://localhost:3000`.

### 4. Validate the config

```bash
# View the fully merged Docker Compose config
docker compose config

# Check real-time logs
docker compose logs -f

# Container resource usage
docker stats --no-stream
```

## Production Deployment

> **Recommended server:** Hetzner CX32 (3 vCPU, 8 GB RAM). Chromium/Playwright requires ≥ 8 GB to avoid OOM kills.

```bash
# 1. Set up the global Traefik reverse proxy (one-time)
docker network create webproxy
cd traefik-global && docker compose up -d && cd ..

# 2. Deploy the application stack
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

See [Hetzner_VPS_Guideline.md](Hetzner_VPS_Guideline.md) for detailed server setup, firewall rules, and Docker secrets configuration.

### Rebuilding a single service

```bash
docker compose build sales-recon-openclaw
docker compose up -d --no-deps sales-recon-openclaw
```

## Environment Variables

Create a `.env` file in the project root (gitignored). Key variables:

| Variable | Description |
|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | Shared secret for ws-proxy ↔ OpenClaw authentication |
| `OPENCLAW_CONFIG_DIR` | Host path for persistent OpenClaw config volume |
| `OPENCLAW_WORKSPACE_DIR` | Host path for persistent workspace volume |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (used by test-ui) |
| `CLERK_SECRET_KEY` | Clerk secret key (used by ws-proxy) |
| `TAVILY_API_KEY` | Enables the Tavily web search MCP skill |
| `XAI_API_KEY` | xAI / Grok API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `MOONSHOT_API_KEY` | Moonshot API key |
| `MINIMAX_API_KEY` | MiniMax API key |

## Project Structure

```
sales-recon/
├── Dockerfile                    # Extended OpenClaw image (+ Python, Playwright, Crawl4AI)
├── docker-compose.yml            # Base service definitions
├── docker-compose.override.yml   # Local dev port mappings (gitignored)
├── docker-compose.prod.yml       # Production Traefik labels
├── docker-setup.sh               # Server provisioning helper
├── scripts/
│   └── docker-entrypoint.release.sh  # Container startup — registers MCP servers
├── skills/
│   └── crawl4ai-service/         # Python MCP server for web scraping
├── ws-proxy/                     # Node.js WebSocket proxy
│   ├── index.js                  # Main proxy logic
│   ├── device.js                 # Device identity management
│   └── package.json
├── test-ui/                      # Next.js chat frontend
│   ├── app/                      # App Router pages & components
│   └── package.json
├── traefik-global/               # Global reverse proxy stack
│   └── docker-compose.yml
├── Hetzner_VPS_Guideline.md      # Production server setup guide
└── DEPLOYMENT_REPORT.md          # Deployment history & notes
```

## MCP Skills

MCP (Model Context Protocol) servers are automatically registered on every container start via the entrypoint script:

| Skill | Transport | Description |
|---|---|---|
| **Tavily** | HTTP | Web search powered by Tavily API |
| **Crawl4AI** | stdio | High-performance web scraping using Playwright + Chromium |

```bash
# List registered MCP servers
docker exec -it sales-recon-openclaw npx mcporter config list
```

## Useful Commands

```bash
# Shell into the OpenClaw container
docker exec -it sales-recon-openclaw bash

# Shell into the ws-proxy container
docker exec -it sales-recon-ws-proxy sh

# OpenClaw health check
docker exec sales-recon-openclaw node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"

# Frontend linting
cd test-ui && npm run lint
```

## License

Proprietary — all rights reserved.
