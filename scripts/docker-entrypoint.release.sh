#!/bin/bash
set -e

# --- gbrain (load-bearing; failures abort the deployment) ---
# The agent depends on gbrain.get_page / gbrain.put_page for centralized
# research. A degraded container is worse than a failed deploy, so every
# step here is hard-fail.

if [ -z "${DATABASE_URL:-}" ]; then
    echo "[entrypoint] FATAL: DATABASE_URL is required for gbrain" >&2
    exit 1
fi

# Resolve the actual gbrain binary at runtime. `bun link` installs it under
# /home/node/.bun/bin, not /home/node/gbrain/bin — never hardcode the path.
GBRAIN_BIN="$(command -v gbrain || true)"
if [ -z "$GBRAIN_BIN" ] || [ ! -x "$GBRAIN_BIN" ]; then
    echo "[entrypoint] FATAL: gbrain binary not found on PATH (resolved='$GBRAIN_BIN')" >&2
    exit 1
fi
echo "[entrypoint] gbrain binary: $GBRAIN_BIN"

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
    echo "[entrypoint] FATAL: no embedding provider env set (set GEMINI_API_KEY or OPENAI_API_KEY)" >&2
    exit 1
fi

echo "[entrypoint] running gbrain init --supabase --non-interactive against managed Postgres"
# gbrain init defaults to PGLite; --supabase + --url targets the external
# Postgres engine. --non-interactive is required when there is no TTY.
# shellcheck disable=SC2086
"$GBRAIN_BIN" init --supabase --non-interactive --url "$DATABASE_URL" $EMBED_FLAGS

if [ ! -f /app/dist/index.js ]; then
    echo "[entrypoint] FATAL: /app/dist/index.js missing — OpenClaw image broken" >&2
    exit 1
fi

# Register gbrain as an OpenClaw MCP server. The JSON uses literal ${VAR}
# placeholders for the env values so OpenClaw passes the live container env
# to the spawned MCP process at agent-invocation time. The command path is
# interpolated now (resolved $GBRAIN_BIN), the env vars stay as placeholders.
echo "[entrypoint] registering gbrain MCP server with OpenClaw"
node /app/dist/index.js mcp set gbrain \
    "$(printf '{"command":"%s","args":["serve"],"env":{"DATABASE_URL":"${DATABASE_URL}","GOOGLE_GENERATIVE_AI_API_KEY":"${GOOGLE_GENERATIVE_AI_API_KEY}","OPENAI_API_KEY":"${OPENAI_API_KEY}"}}' "$GBRAIN_BIN")"

# Spawn probe: catches the class of bug where the registered absolute path
# does not actually exist (the original gbrain ENOENT regression). --version
# exits quickly and does not touch the DB.
echo "[entrypoint] probing gbrain binary at registered path"
"$GBRAIN_BIN" --version >/dev/null

# Seed exec-approval allowlist patterns for the autonomous cron agent so it
# can run the binaries it needs without an interactive approval prompt.
# Under `tools.exec.security: "allowlist"` the safeBins list in openclaw.json
# is decorative — only entries seeded here are actually permitted, so this
# loop must mirror safeBins. `allowlist add` is idempotent. Soft-fail is
# acceptable: it only forces interactive approval at agent-run time.
# Builtins (echo, pwd) intentionally excluded: `sh -c` resolves them via the
# shell builtin and they never hit the exec allowlist; `command -v` also
# returns the bare word for them, which would seed a junk entry.
SEED_BINS="python3 curl sleep cat touch mkdir rm trash ls head tail wc grep find"
for bin in $SEED_BINS; do
    resolved="$(command -v "$bin" || true)"
    if [ -z "$resolved" ]; then
        echo "[entrypoint] WARNING: $bin not on PATH; skipping allowlist seed"
        continue
    fi
    case "$resolved" in
        /*) ;;
        *)
            echo "[entrypoint] WARNING: $bin resolved to non-absolute '$resolved' (likely a shell builtin); skipping"
            continue
            ;;
    esac
    echo "[entrypoint] allowlisting $resolved for agent main"
    node /app/dist/index.js approvals allowlist add --agent main "$resolved" \
        || echo "[entrypoint] WARNING: allowlist add failed for $resolved; continuing"
done

echo "[entrypoint] allowlisting $GBRAIN_BIN for agent main"
node /app/dist/index.js approvals allowlist add --agent main "$GBRAIN_BIN" \
    || echo "[entrypoint] WARNING: allowlist add failed for $GBRAIN_BIN; continuing"

if [ -f "/docker-entrypoint.sh" ]; then
    exec /docker-entrypoint.sh "$@"
else
    exec "$@"
fi
