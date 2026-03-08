# Hetzner VPS Deployment Guideline: From Zero to Production

This guide walks you through setting up a brand-new Hetzner VPS, securing it, installing Docker, and deploying the complete Sales-Recon stack behind a global Traefik reverse proxy.

## What You're Deploying

| Component | Container | Domain | Purpose |
|---|---|---|---|
| **Global Traefik Proxy** | `global-traefik` | — | Routes all HTTPS traffic, auto-provisions SSL |
| **Personal Website** | `hollingworthllc-web` | `maximh.us` / `www.maximh.us` | Static landing page |
| **OpenClaw AI Gateway** | `sales-recon-openclaw` | `control.maximh.us` | AI engine with Playwright/Chromium web scraping |
| **WebSocket Proxy** | `sales-recon-ws-proxy` | `chat.maximh.us` | Clerk-authenticated WebSocket bridge for browser clients |

### Architecture

```
Browser (test-ui)
    │
    ▼ wss://chat.maximh.us (Clerk JWT)
┌──────────────────────────────────────────┐
│  Global Traefik (ports 80/443)           │
│  TLS termination + auto Let's Encrypt    │
└──────────┬──────────────┬────────────────┘
           │              │
           ▼              ▼
   ws-proxy:8080    control:50045
   (chat.maximh.us)  (control.maximh.us)
           │
           ▼ ws://sales-recon-openclaw:50045
   sales-recon-openclaw
   (AI gateway + MCP skills)
```

### Docker Compose File Strategy

| File | Purpose | When Used |
|---|---|---|
| `docker-compose.yml` | Base config: services, env vars, networks | Always |
| `docker-compose.override.yml` | Local dev: exposes ports `50045:50045` and `8080:8080` | Auto-merged locally (gitignored) |
| `docker-compose.prod.yml` | Traefik labels for `chat.maximh.us` and `control.maximh.us` | Explicitly merged on production |

---

## Stage 1: Provisioning the Server & Initial Security Setup

### 1.1 Create the Server on Hetzner
1. Log in to your Hetzner Cloud Console.
2. Click **New Project** (or select an existing one) and click **Add Server**.
3. **Location:** Choose the closest data center (e.g., Ashburn, VA or Falkenstein, DE).
4. **Image:** Select **Ubuntu 24.04**.
5. **Type:** Choose **Shared vCPU**, then click **ARM64** (cheaper and highly performant) or **x86**.
   - **Recommendation:** Choose **CX32 (3 vCPU, 8GB RAM)**. The Chromium/Playwright instance in the OpenClaw container will OOM-kill on smaller 4GB servers.
6. **SSH Keys:** Click "Add SSH key". Provide your public SSH key from your Mac (usually `~/.ssh/id_rsa.pub` or `~/.ssh/id_ed25519.pub`).
7. **Name:** Name it `ubuntu-vps-1` (or whatever you like).
8. Click **Create & Buy now**.

### 1.2 Connect to the Server
```bash
ssh root@your-server-ip

# If prompted "Are you sure you want to continue connecting?", type "yes"
```

### 1.3 Initial Server Hardening
```bash
# Update all packages
apt update && apt upgrade -y

# Disable password authentication (SSH key only)
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart sshd
```

### 1.4 Install Docker
```bash
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker
```

### 1.5 Configure the Firewall
```bash
# Install and enable UFW
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (ACME challenges)
ufw allow 443/tcp   # HTTPS
ufw enable
```

Also configure at the **Hetzner Cloud Console** level:
1. Go to **Firewalls** → **Create Firewall**
2. Add inbound rules: SSH (22, your IP only), HTTP (80), HTTPS (443)
3. Drop all other inbound traffic
4. Apply the firewall to your server

---

## Stage 2: Setting up DNS (Domain Names)

Before deploying Traefik, you **must** point your domains to your server's IP address. Traefik cannot generate SSL certificates until DNS resolves correctly.

Go to your domain registrar and create these **A Records**:

| Subdomain | Record Type | Name/Host | Value |
|---|---|---|---|
| Personal site | A | `@` and `www` | `your-server-ip` |
| Chat (ws-proxy) | A | `chat` | `your-server-ip` |
| Control UI (OpenClaw) | A | `control` | `your-server-ip` |

> **Tip:** Set a low TTL (300 seconds) on your DNS records to speed up propagation. If Traefik fails to get a certificate initially, wait an hour and restart it.

---

## Stage 3: Deploying the Global Traefik Proxy

Traefik is the traffic cop. It listens on ports 80 and 443, automatically provisions SSL certificates from Let's Encrypt, and forwards traffic to the correct Docker container based on the domain name.

### 3.1 Create the Shared Docker Network
```bash
# Still connected via SSH as root
docker network create webproxy
```

### 3.2 Set Up the Traefik Directory
```bash
mkdir -p /opt/traefik-global/letsencrypt
touch /opt/traefik-global/letsencrypt/acme.json
chmod 600 /opt/traefik-global/letsencrypt/acme.json
```

### 3.3 Create the Traefik Configuration

The `traefik-global/docker-compose.yml` is already in the Sales-Recon repository, but you can also deploy it from `/opt/traefik-global/` on the server. Here is the exact configuration:

```bash
cd /opt/traefik-global
nano docker-compose.yml
```

Paste the following:

```yaml
services:
  traefik:
    image: traefik:latest
    container_name: global-traefik
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    command:
      - "--api.insecure=false"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--providers.docker.network=webproxy"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      - "--entrypoints.web.http.redirections.entrypoint.scheme=https"
      - "--entrypoints.websecure.address=:443"
      # Prevent Traefik from dropping long-running WebSocket/AI-streaming connections
      - "--entrypoints.websecure.transport.respondingTimeouts.idleTimeout=600s"
      - "--entrypoints.websecure.transport.respondingTimeouts.readTimeout=600s"
      - "--entrypoints.websecure.transport.respondingTimeouts.writeTimeout=600s"
      - "--certificatesresolvers.myresolver.acme.tlschallenge=true"
      - "--certificatesresolvers.myresolver.acme.email=eusholli@gmail.com"
      - "--certificatesresolvers.myresolver.acme.storage=/letsencrypt/acme.json"
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
      - "./letsencrypt:/letsencrypt"
    networks:
      - webproxy

networks:
  webproxy:
    external: true
```

> **Important:** The WebSocket timeout settings (600s) are critical for Sales-Recon. AI-generated responses can stream for minutes; without these timeouts, Traefik will kill the connection mid-stream.

*To save in `nano`: Press `Ctrl+O`, hit `Enter`, then press `Ctrl+X` to exit.*

### 3.4 Start Traefik
```bash
docker compose up -d

# Verify it's running:
docker compose ps
# You should see 'global-traefik' with status 'Up'
```

---

## Stage 4: Deploying Your Personal Website

### 4.1 Clone the Repository
```bash
cd /opt
git clone https://github.com/eusholli/hollingworthllc.git
cd hollingworthllc
```

### 4.2 Create the Production Compose File
```bash
nano docker-compose.prod.yml
```

Paste the following, **replacing `maximh.us` with your actual domain if different**:

```yaml
services:
  web:
    image: nginx:alpine
    container_name: hollingworthllc-web
    restart: unless-stopped
    volumes:
      - ./:/usr/share/nginx/html:ro
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=webproxy"
      - "traefik.http.routers.hollingworthllc.rule=Host(`maximh.us`, `www.maximh.us`)"
      - "traefik.http.routers.hollingworthllc.entrypoints=websecure"
      - "traefik.http.routers.hollingworthllc.tls.certresolver=myresolver"
    networks:
      - webproxy

networks:
  webproxy:
    external: true
```
*Save: `Ctrl+O`, `Enter`, `Ctrl+X`.*

### 4.3 Start the Website
```bash
docker compose -f docker-compose.prod.yml up -d

# Verify:
docker compose -f docker-compose.prod.yml ps
```

**Test:** Navigate to `https://maximh.us` in your browser. Traefik will auto-provision SSL.

---

## Stage 5: Deploying Sales-Recon

### 5.1 Clone and Configure
```bash
cd /opt
git clone https://github.com/eusholli/sales-recon.git
cd sales-recon
```

### 5.2 Create the Production `.env` File

The `.env` file is gitignored — you must create it on the server. Copy it from your local Mac or create it manually:

```bash
nano .env
```

Required variables:

```bash
# OpenClaw
OPENCLAW_GATEWAY_TOKEN="<your-token>"       # Shared secret between ws-proxy and OpenClaw
OPENCLAW_CONFIG_DIR=/opt/sales-recon-data/openclaw          # Host path for persistent OpenClaw config
OPENCLAW_WORKSPACE_DIR=/opt/sales-recon-data/openclaw/workspace  # Host path for persistent workspace
OPENCLAW_GATEWAY_PORT=50045
OPENCLAW_BRIDGE_PORT=50046
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_IMAGE=openclaw:local
OPENCLAW_DOCKER_APT_PACKAGES=

# AI API Keys
GEMINI_API_KEY="<your-key>"
XAI_API_KEY="<your-key>"
TAVILY_API_KEY="<your-key>"
OPENROUTER_API_KEY="<your-key>"
MOONSHOT_API_KEY="<your-key>"
MINIMAX_API_KEY="<your-key>"
ANTHROPIC_API_KEY="<your-key>"

# Clerk Authentication (used by ws-proxy to verify browser JWTs)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="<your-key>"
CLERK_SECRET_KEY="<your-key>"
WS_PROXY_CLERK_SECRET_KEYS="<your-key>,<another-key>"
```

Lock down the file permissions:
```bash
chmod 600 .env
```

> **Note:** On your local Mac, `OPENCLAW_CONFIG_DIR` points to `/Users/yourname/.openclaw`. On the production server, it points to `/opt/sales-recon-data/openclaw` — a shared location accessible by UID 1000 (the `node` user inside Docker containers).

### 5.3 Understand the Docker Compose Files

Sales-Recon uses three compose files that work together:

**`docker-compose.yml` (base — always used):**
- Defines `sales-recon-openclaw` (AI gateway on port 50045) and `ws-proxy` (WebSocket bridge on port 8080)
- Sets up the internal `sales-recon-net` bridge network and the external `webproxy` network
- Both services join `webproxy` so Traefik can route to them

**`docker-compose.override.yml` (local dev only — gitignored, NOT on the server):**
- Exposes ports `50045:50045` and `8080:8080` directly for local development

**`docker-compose.prod.yml` (production — already in the repo):**
- Adds Traefik labels to route `chat.maximh.us` → `ws-proxy:8080` and `control.maximh.us` → `openclaw:50045`
- Includes WebSocket middleware for proper `X-Forwarded-Proto` headers

### 5.4 Validate the Production Configuration

```bash
# Ensure both compose files exist:
ls -l docker-compose.yml docker-compose.prod.yml

# Check the merged config — verify Traefik labels are correct:
docker compose -f docker-compose.yml -f docker-compose.prod.yml config
```

Verify the output shows:
- `ws-proxy` with label `traefik.http.routers.wsproxy-prod.rule=Host('chat.maximh.us')`
- `sales-recon-openclaw` with label `traefik.http.routers.control-prod.rule=Host('control.maximh.us')`
- Both services on the `webproxy` network

### 5.5 Build and Start Sales-Recon

This will take several minutes because the OpenClaw image builds Python, Playwright, and Chromium:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

### 5.6 Verify

1. Wait for the build/startup to finish.
2. Check the running containers:
   ```bash
   docker ps
   ```
   You should see: `sales-recon-openclaw`, `sales-recon-ws-proxy`, `hollingworthllc-web`, and `global-traefik`.

3. Check the logs:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f
   ```
   Look for:
   - `[ws-proxy] Handshake complete, ready for clients` — confirms ws-proxy connected to OpenClaw
   - `[ws-proxy] Device ID: ...` — confirms device identity is loaded

4. Open your browser:
   - `https://chat.maximh.us` — should connect via WebSocket (returns 101 Upgrade)
   - `https://control.maximh.us` — should show the OpenClaw Control UI

---

## Stage 6: Understanding Key Components

### 6.1 ws-proxy (WebSocket Bridge)

The ws-proxy authenticates browser connections and routes messages to OpenClaw:

1. **Browser connects** via `wss://chat.maximh.us?token=<clerk-jwt>`
2. **ws-proxy verifies** the Clerk JWT using `@clerk/backend`
3. **ws-proxy connects** to OpenClaw at `ws://sales-recon-openclaw:50045` using the shared `OPENCLAW_TOKEN`
4. **Device identity** — ws-proxy maintains a persistent Ed25519 keypair in `ws-proxy/data/device.identity.json` for the OpenClaw handshake protocol v3

> **Critical:** The `ws-proxy/data/` directory is volume-mounted. If you lose `device.identity.json`, ws-proxy will generate a new device ID and OpenClaw may reject it. Include this in your backup strategy. This file is gitignored.

### 6.2 OpenClaw Container

Built from a custom `Dockerfile` that extends the base OpenClaw image with:
- Python 3, pip, venv
- Playwright + Chromium (for web scraping via Crawl4AI)
- MCPorter (MCP server manager)
- Custom entrypoint script (`scripts/docker-entrypoint.release.sh`)

**On every container start**, the entrypoint script automatically registers MCP servers:
- **Tavily** — web search (HTTP transport, requires `TAVILY_API_KEY`)
- **Crawl4AI** — web scraping (stdio transport, Python-based)

### 6.3 test-ui (Next.js Frontend)

The `test-ui/` directory contains the browser-side chat interface:
- Built with Next.js
- Uses Clerk for authentication
- Connects to `ws://gateway.local:8080` (local) or `wss://chat.maximh.us` (prod)
- Sends messages as `{type: 'message', content: '...'}`, receives `{type: 'chunk'}` streaming deltas

Run locally for development:
```bash
cd test-ui
npm install
npm run dev
```

---

## Maintenance Cheat Sheet

### Viewing Logs
```bash
# All Sales-Recon containers
cd /opt/sales-recon
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f

# Specific service
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f ws-proxy
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f sales-recon-openclaw

# Global Traefik proxy
docker logs -f global-traefik

# Last N lines
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=100 ws-proxy
```

### Updating an App
```bash
cd /opt/sales-recon
git pull origin main

# Rebuild and restart all services
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# Or rebuild a single service (faster)
docker compose -f docker-compose.yml -f docker-compose.prod.yml build ws-proxy
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps ws-proxy
```

### Updating the Personal Website
```bash
cd /opt/hollingworthllc
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

### Shell Access
```bash
# OpenClaw container (Debian-based)
docker exec -it sales-recon-openclaw bash

# ws-proxy container (Alpine-based)
docker exec -it sales-recon-ws-proxy sh
```

### OpenClaw & MCPorter Commands
```bash
# Health check
docker exec sales-recon-openclaw node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"

# List MCP servers
docker exec -it sales-recon-openclaw npx mcporter config list

# Add a new MCP server
docker exec -it sales-recon-openclaw npx mcporter config add <name> \
  --transport http --url "https://example.com/mcp"
```

### Disk Space Management
Docker images, build cache, and logs will fill your disk over time:
```bash
# Manual cleanup
docker system prune -f --volumes
docker builder prune -f

# Automated cleanup (add to root's crontab with `crontab -e`)
0 3 * * * docker system prune -f --volumes 2>&1 | logger -t docker-prune
0 4 * * 0 docker builder prune -f 2>&1 | logger -t docker-builder-prune
```

### Backup Strategy

Archive these items regularly:

| Item | Path (on server) | Purpose |
|---|---|---|
| OpenClaw config | `/opt/sales-recon-data/openclaw/openclaw.json` | Agent configs, model settings |
| MCPorter config | `/opt/sales-recon-data/openclaw/mcporter.json` | MCP server registrations |
| Workspace data | `/opt/sales-recon-data/openclaw/workspace/` | Agent workspace, sessions |
| ws-proxy identity | `/opt/sales-recon/ws-proxy/data/device.identity.json` | Device keypair (must persist) |
| Environment vars | `/opt/sales-recon/.env` | All API keys and tokens |
| SSL certificates | `/opt/traefik-global/letsencrypt/acme.json` | Let's Encrypt certs |

```bash
# Quick backup script
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
tar -czf "sales-recon-backup-${TIMESTAMP}.tar.gz" \
  /opt/sales-recon-data/openclaw/ \
  /opt/sales-recon/.env \
  /opt/sales-recon/ws-proxy/data/ \
  --exclude='*/node_modules' \
  --exclude='*/.cache'
```

---

## Troubleshooting

### WebSocket Connection Issues
```bash
# Check if ws-proxy successfully connected to OpenClaw
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs ws-proxy | grep "Handshake"

# Should see: "[ws-proxy] Handshake complete, ready for clients"
# If not, check the OpenClaw container is healthy:
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs sales-recon-openclaw
```

### SSL/Certificate Issues
```bash
# Check Traefik logs for certificate errors
docker logs global-traefik 2>&1 | grep -i "acme\|certificate\|error"

# Verify DNS resolves to your server
dig chat.maximh.us +short

# Force certificate renewal (nuclear option)
cd /opt/traefik-global
docker compose down
rm letsencrypt/acme.json
touch letsencrypt/acme.json && chmod 600 letsencrypt/acme.json
docker compose up -d
```

### Out of Memory (OOM) Kills
The OpenClaw container with Playwright/Chromium is memory-hungry. If containers are being killed:
```bash
# Check current memory usage
docker stats --no-stream

# Check kernel OOM logs
dmesg | grep -i "oom\|killed"
```

Solution: Ensure you're using CX32 (8GB RAM) or larger.

### Container Won't Start
```bash
# Check the merged config for syntax errors
docker compose -f docker-compose.yml -f docker-compose.prod.yml config

# Check if ports are already in use
ss -tlnp | grep -E '80|443|8080|50045'

# Check Docker network exists
docker network ls | grep webproxy
```
