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

# Register event-planner MCP server (optional; requires CRON_EVENT_PLANNER_DNS and CRON_SECRET_KEY).
# Both values are bash-substituted at registration time: CRON_EVENT_PLANNER_DNS is a stable infra
# URL and CRON_SECRET_KEY is a shared Bearer token. Unlike stdio servers (gbrain), HTTP MCP servers
# do NOT support ${VAR} placeholder substitution in headers — the value must be embedded directly.
if [ -n "${CRON_EVENT_PLANNER_DNS:-}" ] && [ -n "${CRON_SECRET_KEY:-}" ]; then
    echo "[entrypoint] registering event-planner MCP server with OpenClaw"
    node /app/dist/index.js mcp set event-planner \
        "$(printf '{"url":"%s/api/mcp/sse","headers":{"Authorization":"Bearer %s"}}' "${CRON_EVENT_PLANNER_DNS}" "${CRON_SECRET_KEY}")"
    echo "[entrypoint] event-planner MCP registered"
else
    echo "[entrypoint] CRON_EVENT_PLANNER_DNS or CRON_SECRET_KEY not set — skipping event-planner MCP registration"
fi

# Seed exec-approval allowlist patterns for the autonomous cron agent so it
# can run the binaries it needs without an interactive approval prompt.
# Under `tools.exec.security: "allowlist"` the safeBins list in openclaw.json
# is decorative — only entries seeded here are actually permitted, so this
# block must mirror safeBins. `approvals set` is idempotent.
#
# Hard-fail rule: any failure here leaves the cron agent unable to exec the
# tools it depends on (curl for webhook delivery, python3 for the dispatcher,
# gbrain for memory). A degraded container is worse than a failed deploy —
# matches the existing gbrain-init hard-fail rule. Do not soft-fail.
#
# Builtins (echo, pwd) intentionally excluded: `sh -c` resolves them via the
# shell builtin and they never hit the exec allowlist; `command -v` also
# returns the bare word for them, which would seed a junk entry.
#
# Optimisation: instead of 14 sequential `node approvals allowlist add` calls
# (each paying ~2s Node.js startup), resolve all paths in shell, then do one
# `approvals get --json | python3 merge | approvals set --stdin` round-trip.
# gbrain is kept as a separate explicit `allowlist add` (matches original intent).
SEED_BINS="python3 curl sleep cat touch mkdir rm trash ls head tail wc grep find"
BIN_PATHS=""
for bin in $SEED_BINS; do
    resolved="$(command -v "$bin" || true)"
    if [ -z "$resolved" ]; then
        echo "[entrypoint] FATAL: required bin '$bin' not on PATH" >&2
        exit 1
    fi
    case "$resolved" in
        /*) ;;
        *)
            echo "[entrypoint] FATAL: '$bin' resolved to non-absolute '$resolved' (likely a shell builtin); cannot seed allowlist" >&2
            exit 1
            ;;
    esac
    BIN_PATHS="$BIN_PATHS $resolved"
done

echo "[entrypoint] seeding exec allowlist for SEED_BINS (batch via approvals set)"
if ! node /app/dist/index.js approvals get --json | python3 -c "
import sys, json, uuid
data = json.load(sys.stdin)
new_paths = '''$BIN_PATHS'''.split()
agents = data.setdefault('agents', {})
main   = agents.setdefault('main', {})
entries = main.setdefault('allowlist', [])
existing = {e['pattern'] for e in entries}
for path in new_paths:
    if path and path not in existing:
        entries.append({'id': str(uuid.uuid4()), 'pattern': path,
                        'lastResolvedPath': path, 'lastUsedAt': 0, 'lastUsedCommand': ''})
print(json.dumps(data))
" | node /app/dist/index.js approvals set --stdin; then
    echo "[entrypoint] FATAL: batch allowlist seed failed" >&2
    exit 1
fi
echo "[entrypoint] SEED_BINS allowlisted for agent main"

echo "[entrypoint] allowlisting $GBRAIN_BIN for agent main"
if ! node /app/dist/index.js approvals allowlist add --agent main "$GBRAIN_BIN"; then
    echo "[entrypoint] FATAL: allowlist add failed for $GBRAIN_BIN" >&2
    exit 1
fi

if [ -f "/docker-entrypoint.sh" ]; then
    exec /docker-entrypoint.sh "$@"
else
    exec "$@"
fi
