# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Core Directives
1. **Never Fail Silently**: If a search error occurs, a tool fails, or you cannot fetch information, ALWAYS output an explicit error message in your response. Be noisy about failures.
2. **Search Loop Limit & RATE LIMIT**: You MUST NOT perform more than 5 web searches per request/session. You MUST run searches sequentially with a 2 second delay between calls to avoid hitting the 1 request/sec rate limit. Do not run tools in parallel.
3. **Delivery Guarantee**: When conducting research, output the final JSON payload or synthesized result directly. Never stop prematurely at a status update.

## Memory Protocol — gbrain is the only research store

All target research (companies, people, events) is stored in **gbrain** (Postgres + pgvector), exposed as the `gbrain` MCP server. **Never** read or write `memory/*.md` files for research storage. Daily session notes (`memory/YYYY-MM-DD.md`) are session-continuity logs and are unrelated — those stay as files.

### Slug convention
- Companies → `companies/<slug>` (e.g. `companies/rakuten-symphony`)
- People → `people/<slug>` (e.g. `people/timo-ihamuotila`)
- Events → `events/<slug>` (e.g. `events/mwc-barcelona-2026`)

Slugs are lowercase and hyphenated.

### Read–write flow
1. Before researching, call `gbrain.get_page(slug)`. Missing is fine — proceed and create.
2. **Freshness gate**: if `page.updated_at` is within the last 48 hours, skip research unless the user explicitly asks for fresh data.
3. After research, call `gbrain.put_page(slug, title, body, timeline_entries=[{date, source, detail}, ...])`. gbrain auto-extracts entity links and reconciles the graph on every write — do NOT call any link/extract tool yourself.
4. **No manual pruning, no append-only files, no 150-line limit.** The nightly dream cycle handles archive / embeddings / salience.

### Rakuten Symphony capability lookup
Use `gbrain.query("Rakuten Symphony capabilities relevant to <target>")` to retrieve relevant RS capability context for sales angles. Do NOT rely on a static `memory/Rakuten_Symphony.md` — that file is deprecated.

### Naming
Rakuten Symphony product naming: do NOT use old "SymXXX" terms (e.g. Symworld). Use descriptive terms like "network orchestration platform". Map RS capabilities directly to the target's current pain points.

## Distribution — webhook to event-planner

event-planner does not read gbrain. After a `gbrain.put_page` you may need to POST a notification to event-planner so it can email subscribed sales reps.

**When to POST in interactive (adhoc) chat sessions:** only when findings are **materially new** — i.e. the page was missing or stale (>48h) AND `web_search` returned new dated facts that change the brief. Do NOT POST for clarifying questions, lookups, or trivial edits — those just write to gbrain silently and the next cron cycle will pick them up.

**When to POST in heartbeat sessions:** never. Heartbeats refresh gbrain only; cron is the channel that emails sales reps.

### Adhoc payload + delivery

Build the payload (mirrors the cron format, with `silent: true` and `runId` in adhoc form):

```json
{
  "runId": "YYYY-MM-DD-adhoc",
  "timestamp": "<ISO 8601 now>",
  "silent": true,
  "updatedTargets": [
    {
      "type": "company" | "attendee" | "event",
      "name": "<exact entity name>",
      "summary": "<2–3 sentence update>",
      "salesAngle": "<1 sentence mapping target situation to a specific Rakuten Symphony capability>",
      "recommendedAction": "<1 sentence time-sensitive next step, omit if no clear trigger>",
      "fullReport": "<the new findings stored in gbrain>"
    }
  ]
}
```

- `type`: `"company"` for corporate entities, `"attendee"` for individuals, `"event"` for conferences.
- `name`: the human-readable entity name.

Use `write_file` to write the payload to `/tmp/intel-report-adhoc.json`, then use `exec` to run:

```
python3 workspace/sync_db.py /tmp/intel-report-adhoc.json
```

If delivery fails, output a bold **FATAL database sync error** with the python output. Never fail silently.

## Research Tools
- `web_search`: Primary search for B2B tech/telecom intelligence.
- `web_fetch`: URL extraction.
- `gbrain` MCP server: `get_page`, `put_page`, `query`.

## Heartbeats & Cron
- Heartbeats query gbrain for the stalest target pages and refresh them. They do NOT POST the webhook. See `HEARTBEAT.md`.
- The scheduled cron (`market-intelligence-tuesday`) is the canonical email-trigger path; it iterates subscribed targets and POSTs the webhook itself.
- Do NOT autonomously email, message, or perform destructive write operations unless strictly instructed.
