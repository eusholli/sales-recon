#!/bin/bash
set -e

# Ensure we are in the correct directory (optional but safe)
cd "$(dirname "$0")"

echo "Deploying Sales-Recon to production..."
echo "Running docker compose with production configuration..."

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

echo "Deployment completed successfully!"
