# Implementation Plan — OpenClaw Performance Optimization

**Date:** 2026-03-06
**Repo:** `.openclaw` (agent config) + `~/dev/sales-recon/` (Docker build context)

---

## Prerequisites

- Docker running with `sales-recon-openclaw` container active
- `TAVILY_API_KEY` set in environment / Docker secrets
- Both repos checked out and up to date

---

## Step 1: Instrument Crawl4AI service (~/dev/sales-recon/)

**File:** `skills/crawl4ai-service/server.py`
**Status:** Done (updated in this session)

**Changes made:**
- Added `import logging` and `import time`
- Added `logging.basicConfig(...)` at module level (outputs to Docker logs)
- Wrapped `crawl_url` with `perf_counter` timing for: browser config init, crawler pool acquisition, HTTP fetch + DOM load, content extraction, total call time
- Each phase logs: `[crawl4ai] INFO HH:MM:SS <phase> Δt=Xs ...`

**Action required:** Container image rebuild (server.py is baked into the image):
```bash
cd ~/dev/sales-recon
docker compose build
docker compose up -d
```

**Verify:** After a research task that calls `crawl_url`:
```bash
docker compose logs --tail=50 sales-recon-openclaw | grep crawl4ai
```
Expected output:
```
10:32:01 [crawl4ai] INFO crawl_url START url=https://...
10:32:01 [crawl4ai] INFO browser_config_init Δt=0.001s
10:32:02 [crawl4ai] INFO crawler_ready (pool_acquire) Δt=0.842s
10:32:04 [crawl4ai] INFO http_fetch+dom_load Δt=2.103s success=True
10:32:04 [crawl4ai] INFO content_extraction Δt=0.012s len=4821
10:32:04 [crawl4ai] INFO crawl_url END url=https://... total=3.021s
```

---

## Step 2: Upgrade search_rakuten.py to timing harness (.openclaw)

**File:** `workspace/search_rakuten.py`
**Status:** Done (updated in this session)

**Changes made:**
- Full rewrite: added `argparse` CLI, `perf_counter` timing across import / client init / API call phases
- Outputs structured JSON with `timing`, `results_count`, per-result metadata
- Uses `os.environ["TAVILY_API_KEY"]` (no hardcoded key)
- Accepts `--depth`, `--topic`, `--max-results` flags

**Verify:**
```bash
python3 workspace/search_rakuten.py "Nokia 5G strategy 2026" --depth basic --topic news
```
Expected output (abbreviated):
```json
{
  "query": "Nokia 5G strategy 2026",
  "params": {"depth": "basic", "topic": "news", "max_results": 5},
  "timing": {
    "import_s": 0.312,
    "client_init_s": 0.001,
    "api_call_s": 1.204,
    "total_s": 1.517
  },
  "results_count": 5,
  "results": [...]
}
```

---

## Step 3: Update workspace/AGENTS.md (.openclaw)

**File:** `workspace/AGENTS.md`
**Status:** Done (updated in this session)

**Changes made:**
1. **Research Tools table** — Added `tavily-mcp: tavily-search` and `crawl4ai: crawl_url` with latency estimates and tool selection guide.
2. **Research Decision Tree** — Updated all four branches:
   - Deep dive: now fires `web_search` + `tavily-search` **in parallel**
   - Quick news: routes to `tavily-mcp: tavily-search` with `topic="news"`
   - URL content: uses `crawl4ai: crawl_url` (with `web_fetch` as fallback)
3. **Timing Protocol section** — New section instructing Kenji to timestamp each tool call and log a `## Performance Log` block to the daily memory file.

**Action required:** Container restart (AGENTS.md is volume-mounted, not baked):
```bash
cd ~/dev/sales-recon
docker compose restart sales-recon-openclaw
```

---

## Step 4: Update workspace/TOOLS.md (.openclaw)

**File:** `workspace/TOOLS.md`
**Status:** Done (updated in this session)

**Changes made:** Added `## MCP Tools` section documenting:
- `tavily-mcp: tavily-search` — all parameters, expected latency, best-use notes
- `crawl4ai: crawl_url` — parameters, latency, cache behavior, rebuild requirement

**Action required:** Container restart (same as Step 3).

---

## Step 5: Apply container changes

After Steps 1–4, apply all changes:

```bash
cd ~/dev/sales-recon

# If server.py was changed (Step 1): rebuild required
docker compose build
docker compose up -d

# If only workspace/*.md / search_rakuten.py changed: restart is enough
# docker compose restart sales-recon-openclaw
```

> **Note:** If you want to skip the rebuild (Step 1) for now, Steps 2–4 are sufficient to activate Tavily, Crawl4AI, and timing in the agent workflow. Just restart instead of rebuilding.

---

## Step 6: Validate

### 6a. Timing annotations visible in agent response
Ask Kenji: *"Research Nokia 5G strategy 2026 — full deep dive."*
- Response should mention both `web_search` and `tavily-search` being used
- At the end of the response, a timing summary should appear
- `memory/YYYY-MM-DD.md` should have a `## Performance Log` entry

### 6b. Parallel search confirmed
In the timing log, both `web_search` Δt and `tavily-search` Δt should be similar in magnitude (e.g., both ~2–3s), confirming they ran in parallel rather than serially (which would show one starting after the other completes).

### 6c. Tavily benchmark
```bash
python3 workspace/search_rakuten.py "Nokia 5G strategy 2026" --depth basic --topic news
```
Confirm `api_call_s` < 3s.

### 6d. Crawl4AI timing in Docker logs (requires rebuild from Step 1)
```bash
docker compose logs --tail=100 sales-recon-openclaw | grep crawl4ai
```

### 6e. No web_fetch for heavy URLs
After a research task that fetches URL content, confirm Kenji used `crawl_url` not `web_fetch` (visible in verbose output).

---

## Rollback

All changes are in tracked files. To revert:
```bash
git diff workspace/AGENTS.md   # review
git checkout workspace/AGENTS.md
git checkout workspace/TOOLS.md
git checkout workspace/search_rakuten.py
# server.py is in ~/dev/sales-recon — revert there separately
```
