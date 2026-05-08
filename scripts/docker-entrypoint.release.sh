#!/bin/bash
set -e

# Idempotent gbrain schema migration. Safe to run on every container start.
# `gbrain init` applies any new schema migrations against $DATABASE_URL and
# is a no-op when the schema is already current. See
# /home/node/gbrain/INSTALL_FOR_AGENTS.md.
if [ -n "${DATABASE_URL:-}" ] && command -v gbrain >/dev/null 2>&1; then
    # Pick the embedding provider. Prefer Gemini (768 dims, cheap) when its key
    # is present; fall back to OpenAI (1536 dims) only when Gemini is missing.
    # gbrain locks the embedding model into ~/.gbrain/config.json on first init;
    # re-running is idempotent and does not change a previously committed model.
    EMBED_FLAGS=""
    if [ -n "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ]; then
        EMBED_FLAGS="--model google"
        echo "[entrypoint] embedding provider: google (Gemini, 768d)"
    elif [ -n "${OPENAI_API_KEY:-}" ]; then
        EMBED_FLAGS="--model openai"
        echo "[entrypoint] embedding provider: openai (1536d)"
    else
        echo "[entrypoint] WARNING: no embedding provider env set (set GEMINI_API_KEY or OPENAI_API_KEY)"
    fi

    echo "[entrypoint] running gbrain init --supabase --non-interactive against managed Postgres"
    # gbrain init defaults to PGLite; --supabase + --url targets the external
    # Postgres engine. --non-interactive is required when there is no TTY.
    # shellcheck disable=SC2086
    gbrain init --supabase --non-interactive --url "$DATABASE_URL" $EMBED_FLAGS \
        || echo "[entrypoint] WARNING: gbrain init failed; continuing"

    # Register gbrain as an OpenClaw MCP server so the agent can call get_page,
    # put_page, query, etc. Uses literal placeholders ${VAR} so OpenClaw passes
    # the live container env to the spawned MCP process at agent-invocation
    # time (rather than baking values into ~/.openclaw/openclaw.json).
    if [ -f /app/dist/index.js ]; then
        echo "[entrypoint] registering gbrain MCP server with OpenClaw"
        node /app/dist/index.js mcp set gbrain \
            '{"command":"/home/node/gbrain/bin/gbrain","args":["serve"],"env":{"DATABASE_URL":"${DATABASE_URL}","GOOGLE_GENERATIVE_AI_API_KEY":"${GOOGLE_GENERATIVE_AI_API_KEY}","OPENAI_API_KEY":"${OPENAI_API_KEY}"}}' \
            || echo "[entrypoint] WARNING: gbrain MCP registration failed; continuing"
    fi
else
    echo "[entrypoint] skipping gbrain init (DATABASE_URL unset or gbrain missing)"
fi

# Seed exec-approval allowlist patterns for the autonomous cron agent so it
# can run python3 (sync_db.py), curl (event-planner webhook), and gbrain
# (nightly dream cycle) without an interactive approval prompt. Idempotent:
# `allowlist add` is a no-op if the pattern is already present.
if [ -f /app/dist/index.js ]; then
    for pattern in /usr/bin/python3 /usr/bin/curl /home/node/gbrain/bin/gbrain; do
        echo "[entrypoint] allowlisting $pattern for agent main"
        node /app/dist/index.js approvals allowlist add --agent main "$pattern" \
            || echo "[entrypoint] WARNING: allowlist add failed for $pattern; continuing"
    done
fi

if [ -f "/docker-entrypoint.sh" ]; then
    exec /docker-entrypoint.sh "$@"
else
    exec "$@"
fi
