# Investigation: sales-recon-openclaw Health Check Delay

## Context

After `docker compose up`, `deploy-prod.sh` polls `node dist/index.js health` every 3 seconds.
Users observed a long wait (30–60s) before "sales-recon-openclaw is healthy." is printed.
Goal: identify root cause and assess whether it's a problem.

## Root Cause

The delay is **not** in the health check polling — `node dist/index.js health` returns fast once the server is up. The delay is in the **entrypoint script** (`scripts/docker-entrypoint.release.sh`), which must finish before the OpenClaw gateway process even starts.

### Entrypoint time breakdown (estimated on Hetzner CX32)

| Step | File:Lines | Est. time |
|---|---|---|
| `gbrain init --supabase --non-interactive` | L43 | 5–15s (DB + network roundtrips) |
| `node dist/index.js mcp set gbrain` | L55 | ~2s (Node startup) |
| 14x `node dist/index.js approvals allowlist add` (SEED_BINS) | L79–97 | ~28s (14 × 2s Node startup) |
| 1x `node dist/index.js approvals allowlist add` (gbrain) | L100 | ~2s |
| **Total before server starts** | | **~37–47s** |

The 14 `SEED_BINS` (`python3 curl sleep cat touch mkdir rm trash ls head tail wc grep find`) + gbrain = **15 sequential `node dist/index.js` invocations**, each paying full Node.js startup cost.

### Docker healthcheck is not the bottleneck

`docker-compose.yml:60–65` defines a Docker-native healthcheck (`interval: 60s`, `start_period: 30s`), but `deploy-prod.sh` does its own polling independently. Neither adds to the core delay — both are just waiting for the server to start.

## Is this a problem?

**Deployment UX:** Yes — ~40s added to every deploy is annoying but not dangerous.

**Restart resilience:** Yes — if the container crashes and restarts (`restart: unless-stopped`), it won't be ready to serve requests for ~40s. During that window ws-proxy and viber-proxy will fail to connect.

**Functional correctness:** No — everything eventually works. The entrypoint is designed hard-fail, so if `gbrain init` or any allowlist add fails, the container exits rather than starting in a degraded state.

## Proposed Fix: Batch the allowlist adds

The 15 sequential Node invocations are the biggest controllable cost (~30s). Options, in preference order:

1. **Check if `allowlist add` accepts multiple paths**: If `node dist/index.js approvals allowlist add --agent main <path1> <path2> ...` is supported, replace the entire loop with one call. Reduces ~30s → ~2s.

2. **Write allowlist config directly**: If OpenClaw stores allowlist entries in a JSON file (e.g., in `$OPENCLAW_CONFIG_DIR`), write them in a single `jq` or Python call. Requires understanding the config schema.

3. **Cache across restarts**: The allowlist entries are idempotent — if the config volume (`${OPENCLAW_CONFIG_DIR}`) persists them, skip seeding when entries already exist.

## Files to Modify

- `scripts/docker-entrypoint.release.sh:78–103` — replace the loop with a single batched call

## Verification

After the change:
1. `docker compose build sales-recon-openclaw`
2. `docker compose up -d --no-deps sales-recon-openclaw`
3. Time from "Started" to "is healthy" in deploy script output — should drop from ~40s to ~10s
