#!/bin/bash
set -e

# --- Configuration Helpers ---

configure_tavily() {
    if [ -n "$TAVILY_API_KEY" ]; then
        echo "Registering Tavily MCP server via mcporter..."
        # We need to run this as the user who owns the config (node)
        # Assuming script runs as root initially or has writable access to home
        
        # Configure mcporter
        npx mcporter config add tavily \
          --transport http \
          --url "https://mcp.tavily.com/mcp/?tavilyApiKey=\${TAVILY_API_KEY}" || {
             echo "Failed to register Tavily MCP server with mcporter."
        }
    else
        echo "Skipping Tavily MCP registration (TAVILY_API_KEY not set)."
    fi
}

configure_crawl4ai() {
    echo "Registering Crawl4AI MCP server via mcporter..."
    # We need to run this as the user who owns the config (node)
    # Assuming script runs as root initially or has writable access to home
    
    # Configure mcporter
    npx mcporter config add crawl4ai \
        --command "python3" \
        --arg "/app/skills/crawl4ai-service/server.py" \
        --description "High-performance web scraping for Symphony Signal" || {
            echo "Failed to register Crawl4AI MCP server with mcporter."
        }
}

# --- Main Execution ---

# 1. Run configurations
configure_tavily
configure_crawl4ai

# 2. Pass control to the original entrypoint or CMD
# If the base image has an entrypoint, we should respect it or call it.
# The base image (Dockerfile) has ENTRYPOINT ["/docker-entrypoint.sh"]
# preventing infinite loop if we are overwriting it.
# We will use the original script if it exists, otherwise just execute CMD.

if [ -f "/docker-entrypoint.sh" ]; then
    echo "Delegating to original entrypoint..."
    exec /docker-entrypoint.sh "$@"
else
    echo "Starting OpenClaw..."
    exec "$@"
fi
