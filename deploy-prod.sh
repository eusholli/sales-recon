#!/bin/bash
set -e

# Ensure we are in the correct directory (optional but safe)
cd "$(dirname "$0")"

# Load .env if present so OPENCLAW_GATEWAY_TOKEN and cron vars are available
if [ -f "$(dirname "$0")/.env" ]; then
    set -a
    source "$(dirname "$0")/.env"
    set +a
fi

echo "Deploying Sales-Recon to production..."
echo "Running docker compose with production configuration..."

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

echo "Waiting for sales-recon-openclaw to be healthy..."
MAX_WAIT=60
WAIT=0
until docker compose exec -T sales-recon-openclaw node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN" > /dev/null 2>&1; do
    if [ "$WAIT" -ge "$MAX_WAIT" ]; then
        echo "ERROR: sales-recon-openclaw did not become healthy within ${MAX_WAIT}s. Cron jobs NOT updated."
        exit 1
    fi
    sleep 3
    WAIT=$((WAIT + 3))
done
echo "sales-recon-openclaw is healthy."

if [ -n "$CRON_EVENT_PLANNER_DNS" ]; then
    echo "Registering event planner cron jobs..."
    python3 "$(dirname "$0")/event-planner-cron.py"
    echo "Cron jobs registered."
else
    echo "CRON_EVENT_PLANNER_DNS not set — skipping cron job registration."
fi

echo "Deployment completed successfully!"
