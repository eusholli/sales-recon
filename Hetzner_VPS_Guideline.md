# Hetzner VPS Deployment Guideline: From Zero to Global Proxy

This guide will walk you through setting up a brand new Hetzner VPS, securing it, installing Docker, and deploying three things behind a single Traefik reverse proxy:
1. **Global Traefik Proxy:** The router that directs all internet traffic.
2. **Personal Website (`hollingworthllc`):** A static landing page.
3. **Sales-Recon App:** Your complex AI-enabled web application.

This guide assumes you have never done this before. Follow the steps exactly in order.

---

## Stage 1: Provisioning the Server & Initial Security Setup

### 1.1 Create the Server on Hetzner
1. Log in to your Hetzner Cloud Console.
2. Click **New Project** (or select an existing one) and click **Add Server**.
3. **Location:** Choose the one closest to you (e.g., Ashburn, VA or Falkenstein, DE).
4. **Image:** Select **Ubuntu 24.04**.
5. **Type:** Choose **Shared vCPU**, then click **ARM64** (it's cheaper and highly performant) or **x86**. 
   - *Recommendation for Sales-Recon:* Choose **CX32 (3 vCPU, 8GB RAM)**. The Chromium Playwright instance in Sales-Recon will crash on smaller 4GB servers.
6. **SSH Keys:** Click "Add SSH key". Provide your public SSH key from your Mac (usually found at `~/.ssh/id_rsa.pub` or `~/.ssh/id_ed25519.pub`). If you don't have one, research "How to generate SSH key Mac" and paste the public key here. This allows you to securely log in without a password.
7. **Name:** Name it `ubuntu-vps-1` (or whatever you like).
8. Click **Create & Buy now**.

### 1.2 Connect to the Server
Hetzner will assign your server a public IP address (e.g., `198.51.100.12`).

Open your Mac terminal and connect:
```bash
# Replace 'your-server-ip' with your actual Hetzner IP
ssh root@your-server-ip

# If it asks "Are you sure you want to continue connecting?", type "yes" and hit enter.
```

### 1.3 Install Docker and Docker Compose
Once logged into your server as `root`, update the system and install Docker:

```bash
# 1. Update all existing software packages
apt update && apt upgrade -y

# 2. Download and install Docker automatically
curl -fsSL https://get.docker.com | sh

# 3. Ensure Docker starts automatically if the server reboots
systemctl enable docker
systemctl start docker
```

---

## Stage 2: Setting up DNS (Domain Names)

Before deploying Traefik, you **must** point your domains to your new server's IP address. Traefik cannot generate an SSL (HTTPS) certificate if the domain doesn't resolve to the server.

Go to your domain registrar (e.g., GoDaddy, Namecheap, Cloudflare) and create the following **A Records**:

1. **For your personal site:**
   - Type: `A`
   - Name/Host: `@` (or `www`)
   - Value: `your-server-ip`
   - TTL: Lowest possible (e.g., 5 min)

2. **For Sales-Recon:**
   - Type: `A`
   - Name/Host: `chat` (or whatever subdomain you want, e.g., `chat.example.com`)
   - Value: `your-server-ip`

*(Note: DNS propagation can take anywhere from 5 minutes to 24 hours. You can proceed, but if Traefik fails to get a certificate initially, just wait an hour and restart it).*

---

## Stage 3: Deploying the Global Traefik Proxy

Traefik is the traffic cop. It listens on ports 80 and 443, grabs SSL certificates from Let's Encrypt automatically, and forwards traffic to the correct Docker container based on the requested domain name.

### 3.1 Create the Shared Docker Network
Traefik needs to talk to all your apps. We create a dedicated network for this.

```bash
# Still connected via SSH as root
docker network create webproxy
```

### 3.2 Create the Traefik Configuration
```bash
# 1. Create a folder for Traefik and go inside it
mkdir -p /opt/traefik-global
cd /opt/traefik-global

# 2. We need a folder to store the generated SSL certificates safely
mkdir letsencrypt
touch letsencrypt/acme.json
chmod 600 letsencrypt/acme.json

# 3. Create the docker-compose file using nano (a text editor)
nano docker-compose.yml
```

### 3.3 Paste the Traefik Config
When `nano` opens, paste the following exact configuration.
**CRITICAL:** Change `eusholli@gmail.com` to your real email address (Let's Encrypt uses this to notify you of expiring certs).

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

*To save in `nano`: Press `Ctrl+O`, hit `Enter` to confirm the filename, then press `Ctrl+X` to exit.*

### 3.4 Start Traefik
```bash
docker compose up -d

# Verify it's running:
docker compose ps
# You should see 'global-traefik' with status 'Up'
```

---

## Stage 4: Deploying your Personal Website

Now we will pull your personal website from GitHub, put it in a container, and connect it to Traefik.

### 4.1 Clone the Repository
```bash
# Go to the main apps folder
cd /opt

# Clone your site
git clone https://github.com/eusholli/hollingworthllc.git
cd hollingworthllc
```

### 4.2 Create the Production Compose File
Your repository likely has its own setup, but we must construct a specific `docker-compose.prod.yml` that hooks into the global proxy.

If your website is just static HTML/JS/CSS files (a "landing page"), we can serve it instantly using a standard Nginx container.

```bash
nano docker-compose.prod.yml
```

Paste the following, **changing `yourdomain.com` to your actual website domain**:

```yaml
services:
  web:
    # If your repo has a Dockerfile, change this to: build: .
    # If it's just static files in the root directory, use nginx directly:
    image: nginx:alpine
    container_name: hollingworthllc-web
    restart: unless-stopped
    volumes:
      - ./:/usr/share/nginx/html:ro # Mounts this folder to the nginx web root
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=webproxy"
      # REPLACE WITH YOUR DOMAIN
      - "traefik.http.routers.hollingworthllc.rule=Host(`yourdomain.com`, `www.yourdomain.com`)"
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

# Check if it's running
docker compose -f docker-compose.prod.yml ps
```

**Testing:** Go to `https://yourdomain.com` in your browser. Traefik will automatically issue a valid SSL certificate and serve your website!

*(If it doesn't load immediately, wait a minute for Let's Encrypt to process the SSL challenge, or check logs with `docker compose -f docker-compose.prod.yml logs -f`)*

---

## Stage 5: Deploying Sales-Recon

Finally, we deploy the complex AI application.

### 5.1 Clone and Configure
```bash
cd /opt
git clone https://github.com/eusholli/sales-recon.git
cd sales-recon

# You must have your exact production `.env` file here.
# Copy it from your Mac, or create it manually:
nano .env
# Paste all your real API keys inside, save, and exit.
```

### 5.2 Validate the Configuration Files
Sales-Recon requires its `docker-compose.yml` (base components) and a `docker-compose.prod.yml` (the Traefik routing rules) to merge together.

```bash
# Ensure both files exist and list their contents to be safe:
ls -l docker-compose.yml
ls -l docker-compose.prod.yml

# Check the merged config to ensure Traefik labels are applied to ws-proxy
docker compose -f docker-compose.yml -f docker-compose.prod.yml config
```

*Ensure you edit `docker-compose.prod.yml` and replace `chat.yourdomain.com` with the actual subdomain you pointed to the Hetzner IP in Stage 2.*

### 5.3 Start Sales-Recon
Because this builds a massive Chromium Playwright image, this command will take several minutes.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

### 5.4 Verify
1. Wait for compilation to finish.
2. Check the running containers: `docker ps`. You should see `sales-recon-openclaw`, `sales-recon-ws-proxy`, `hollingworthllc-web`, and `global-traefik`.
3. Open your browser and navigate to the subdomain (e.g., `https://chat.yourdomain.com`). Traefik will route the request to `ws-proxy`, securely over HTTPS!

---

## Maintenance Cheat Sheet

**Where do I see errors?**
If any site goes down, check Traefik logs first (to see routing issues), then the app's logs:
```bash
# Check global proxy
docker logs -f global-traefik

# Check sales-recon
cd /opt/sales-recon
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f ws-proxy
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f sales-recon-openclaw
```

**How do I update an app?**
```bash
cd /opt/hollingworthllc  # or /opt/sales-recon
git pull origin main

# Rebuild and restart
docker compose -f docker-compose.prod.yml up -d --build
```
