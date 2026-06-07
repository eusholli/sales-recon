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

# Heal any stale config left over from a previous OpenClaw version (deprecated
# models, removed plugins, etc.) before any command that requires valid config.
# doctor --fix is safe to run on every startup: it is idempotent and runs even
# when the config is invalid.
echo "[entrypoint] running openclaw doctor --fix to heal any stale config"
node /app/dist/index.js doctor --fix

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
# URL and CRON_SECRET_KEY is a shared Bearer token. Uses SSE transport (/api/mcp/sse).
# OpenClaw does not support streamable HTTP (treats the spec-compliant 405 on GET as a fatal error).
# SSE transport requires REDIS_URL or KV_URL to be set in the event-planner environment so that
# the GET (stream) and POST (message) handlers can coordinate via Redis pub/sub.
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
# Optimisation: instead of N sequential `node approvals allowlist add` calls
# (each paying ~2s Node.js startup), resolve all paths in shell, then do one
# `approvals get --json | python3 merge | approvals set --stdin` round-trip.
# gbrain is included here (not a separate allowlist add) so its entry gets the
# same format as all other bins: pattern + lastResolvedPath + lastUsedCommand.
# OpenClaw uses lastResolvedPath for allowlist matching; entries without it are
# silently missed even when pattern matches the resolved binary path.
SEED_BINS="python3 curl sleep cat touch mkdir rm trash ls head tail wc grep find gbrain"
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

# Verify every SEED_BIN path actually landed in the allowlist. The `approvals
# set --stdin` pipeline above only fails on exit codes; a malformed JSON merge
# could still leave entries missing. Re-read the file and assert presence so
# dev and prod cannot silently diverge.
echo "[entrypoint] verifying allowlist contains every SEED_BIN path"
if ! node /app/dist/index.js approvals get --json | BIN_PATHS="$BIN_PATHS" python3 -c "
import os, sys, json
data = json.load(sys.stdin)
# approvals get --json wraps the file contents under a top-level 'file' key;
# fall back to the bare shape in case that envelope changes in future versions.
root = data.get('file', data)
present = {e.get('pattern') for e in root.get('agents', {}).get('main', {}).get('allowlist', [])}
expected = [p for p in os.environ.get('BIN_PATHS', '').split() if p]
missing = [p for p in expected if p not in present]
if missing:
    sys.stderr.write('MISSING: ' + ' '.join(missing) + '\n')
    sys.exit(2)
"; then
    echo "[entrypoint] FATAL: allowlist verification failed — some SEED_BIN paths did not persist" >&2
    exit 1
fi
echo "[entrypoint] allowlist verification ok"

# Start gbrain Minion worker as a background daemon. Runs persistently so jobs
# submitted via MCP (e.g. autopilot-cycle from cron) are picked up immediately.
# Started here (after gbrain init + allowlist seed) so the worker has a valid
# config and DATABASE_URL before it polls the queue. Hard-fail if it exits
# immediately (indicates a bad config), but don't block the main process.
echo "[entrypoint] starting gbrain Minion worker in background"
"$GBRAIN_BIN" jobs work &
GBRAIN_WORKER_PID=$!
sleep 2
if ! kill -0 "$GBRAIN_WORKER_PID" 2>/dev/null; then
    echo "[entrypoint] FATAL: gbrain Minion worker exited immediately (pid=$GBRAIN_WORKER_PID)" >&2
    exit 1
fi
echo "[entrypoint] gbrain Minion worker running (pid=$GBRAIN_WORKER_PID)"

# Start the on-demand marketing campaign runner in the background. It polls
# event-planner for PENDING CampaignRunRequest rows (the "Generate Campaign" button)
# and runs marketing-once.py for each. Soft-fail: it is not load-bearing for the agent,
# so a crash here must not abort the deploy. Only started when CRON wiring is present.
if [ -n "${CRON_EVENT_PLANNER_DNS:-}" ] && [ -n "${CRON_SECRET_KEY:-}" ] && [ -f /app/marketing-runner.py ]; then
    echo "[entrypoint] starting marketing campaign runner in background"
    python3 /app/marketing-runner.py &
    echo "[entrypoint] marketing-runner started (pid=$!)"
else
    echo "[entrypoint] CRON wiring or marketing-runner.py missing — skipping marketing runner"
fi

# Clear stale session write locks left by previous ungraceful shutdowns.
# These are guaranteed stale at startup since the process that held them is gone.
echo "[entrypoint] clearing any stale OpenClaw session write locks"
find /home/node/.openclaw/agents -name "*.jsonl.lock" -delete 2>/dev/null || true

if [ -f "/docker-entrypoint.sh" ]; then
    exec /docker-entrypoint.sh "$@"
else
    exec "$@"
fi
