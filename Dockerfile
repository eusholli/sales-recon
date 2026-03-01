FROM ghcr.io/openclaw/openclaw:2026.2.26

# Switch to root to install dependencies
USER root

# Install Python and Playwright dependencies for Crawl4AI
# The base image is likely Debian-based (bookworm/bullseye)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY skills/crawl4ai-service/requirements.txt /tmp/crawl4ai-requirements.txt

# Install crawl4ai and mcp python packages
# Using --break-system-packages as we are in a container
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/crawl4ai-requirements.txt \
    && pip3 install --no-cache-dir --break-system-packages playwright

# Install playwright system dependencies
RUN playwright install-deps chromium

# Switch back to node user
USER node

# Install playwright browsers
# Install playwright browsers
RUN playwright install chromium

# Symlink Playwright's Chromium to a standard path so OpenClaw's browser tool can find it
USER root
RUN find /home/node/.cache/ms-playwright -name "chrome" -type f | head -1 | xargs -I{} ln -sf {} /usr/local/bin/chromium-browser
USER node

# Persist mcporter config
# Ensure /app/config exists and link mcporter.json to the persistent volume
RUN mkdir -p /app/config && \
    ln -sf /home/node/.openclaw/mcporter.json /app/config/mcporter.json

# Switch to root for global install
USER root
# Install mcporter globally
RUN npm install -g mcporter

# Copy crawl4ai service code
COPY skills/crawl4ai-service /app/skills/crawl4ai-service

# Copy release entrypoint script
COPY scripts/docker-entrypoint.release.sh /docker-entrypoint.release.sh
RUN chmod +x /docker-entrypoint.release.sh

# Switch back to node for runtime
USER node

ENTRYPOINT ["/docker-entrypoint.release.sh"]
CMD ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "50045"]
