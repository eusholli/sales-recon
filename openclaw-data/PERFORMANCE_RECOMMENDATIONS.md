# Performance Recommendations — OpenClaw Search & Crawl

**Audit date:** 2026-03-06
**Agent:** Kenji (Symphony Signal)
**Scope:** web_search, web_fetch, Tavily MCP, Crawl4AI MCP

---

## Executive Summary

The OpenClaw agent has two high-performance MCP tools (Tavily, Crawl4AI) fully configured in `mcporter.json` but not used by the research workflow in `workspace/AGENTS.md`. The agent also executes all searches sequentially. Combined, these gaps add 3–10s of unnecessary latency per research task. The fixes are configuration-level changes — no infrastructure changes required except a container rebuild for Crawl4AI instrumentation.

---

## Tool Inventory

| Tool | Type | Provider | Latency | Was Used? |
|------|------|----------|---------|-----------|
| `web_search` | Built-in | Gemini Google Search Grounding | ~2–5s | Yes |
| `web_fetch` | Built-in | OpenClaw internal HTTP | Unknown (no timeout) | Yes (on-demand) |
| `tavily-mcp: tavily-search` | MCP (remote) | `mcp.tavily.com` | ~0.5–2s | **No** |
| `crawl4ai: crawl_url` | MCP (local Python) | `/app/skills/crawl4ai-service/server.py` | ~2–8s | **No** |

---

## Bottleneck Analysis

### 1. Tavily MCP unused (High Impact)
- Configured in `mcporter.json`, never called from `AGENTS.md`.
- Tavily returns structured results 2–4x faster than Gemini `web_search` for news/freshness queries.
- Estimated savings: **1.5–4s per news-focused query**.

### 2. Crawl4AI MCP unused (Medium Impact)
- Configured in `mcporter.json`, never called from `AGENTS.md`.
- `web_fetch` has no timeout setting — a slow or unresponsive URL can hang the agent indefinitely.
- Crawl4AI uses an async headless browser with `CacheMode.BYPASS` — more reliable for JS-rendered pages.
- `web_fetch` should be demoted to fallback only.

### 3. Sequential-only search pattern (High Impact)
- `AGENTS.md` Research Decision Tree enforced serial calls: check memory → search 1 → search 2.
- Deep-dive tasks could fire `web_search` and `tavily-search` in parallel, halving wall-clock time.
- Estimated savings: **2–5s per deep-dive task**.

### 4. No timeout enforcement (Medium Impact)
- Neither `openclaw.json` nor `AGENTS.md` specifies a timeout for `web_fetch` or MCP tools.
- A single hanging URL fetch can block the entire research task.
- Mitigation: switch to `crawl4ai: crawl_url` (which has browser-level timeouts) as primary.

### 5. No timing instrumentation (Low Impact — Observability)
- No visibility into which sub-operation consumes the most time.
- Without baselines, improvements cannot be measured or justified.
- Fix: add timing annotations to agent workflow + script-level `perf_counter` harness.

### 6. Cache freshness check is model-dependent (Low Impact)
- `AGENTS.md` says "check memory/ first" but freshness evaluation relies entirely on model judgment.
- This is acceptable given the current architecture but means stale data can be returned.

---

## Architectural Recommendations

### Recommendation 1: Replace `web_fetch` with `crawl4ai: crawl_url`
**Priority: High**
Use `crawl4ai: crawl_url` as the primary URL content extraction tool. Fall back to `web_fetch` only if Crawl4AI is unavailable. Crawl4AI handles JS-rendered pages, has implicit browser-level timeouts, and returns clean markdown by default.

### Recommendation 2: Activate Tavily MCP for freshness/news queries
**Priority: High**
Route quick-news and recent-activity queries to `tavily-mcp: tavily-search` with `topic="news"`. Lower latency and structured results are better suited for these patterns than Gemini Search Grounding.

### Recommendation 3: Enable parallel deep-dive (web_search + Tavily simultaneously)
**Priority: High**
For full profile / deep-dive tasks, fire `web_search` and `tavily-search` in parallel rather than sequentially. Both calls can start at the same time; merge results afterward. Wall-clock time drops from ~7–10s to ~3–5s for the combined search phase.

### Recommendation 4: Add agent-level timing protocol
**Priority: Medium**
Instruct Kenji to timestamp each tool call start/end and log a `## Performance Log` block to the daily memory file. This creates an ongoing latency baseline without any infrastructure changes.

### Recommendation 5: Instrument Crawl4AI service with structured timing logs
**Priority: Medium**
Add `logging` + `time.perf_counter()` to `server.py` to expose per-phase timing (browser init, pool acquire, fetch/DOM load, content extraction, total) via Docker container logs. This makes it possible to identify browser cold-start overhead vs. network latency.

### Recommendation 6: Upgrade search_rakuten.py to a timing harness
**Priority: Low**
The existing script is a one-liner with a hardcoded query. Replacing it with a proper CLI + `perf_counter` harness lets you benchmark Tavily latency on demand and compare against Gemini Search Grounding.

---

## Benchmark Methodology

To measure improvements before/after implementing these recommendations:

1. **Baseline (before):** Ask Kenji to deep-dive a new target (e.g. "Nokia 5G strategy 2026"). Note wall-clock time from question to complete response. Observe timing annotations in response.
2. **Tavily baseline:** `python3 workspace/search_rakuten.py "Nokia 5G strategy 2026" --depth basic --topic news` — note `api_call_s` in JSON output.
3. **Crawl4AI baseline:** After rebuild, run a research task involving URL content extraction. Run `docker compose logs -f sales-recon-openclaw` — note `total` timing lines from `crawl4ai-service`.
4. **After:** Repeat the same research task. Compare timing log entries in `memory/YYYY-MM-DD.md` under `## Performance Log`.
5. **Parallel confirmation:** In a deep-dive response, both `web_search` and `tavily-search` Δt values should be close to each other (indicating parallel execution, not serial).

---

## Expected Outcomes

| Change | Expected Latency Reduction |
|--------|---------------------------|
| Parallel web_search + Tavily | ~2–5s per deep-dive |
| Tavily for news queries | ~1.5–4s per news query |
| Crawl4AI replacing web_fetch | Eliminates hangs; ~0–2s savings |
| Timing instrumentation | 0s latency change, full observability |
