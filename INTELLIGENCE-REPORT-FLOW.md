# Intelligence Report System: End-to-End Flow

This document describes the complete lifecycle of an intelligence report — from the scheduled cron trigger through AI-powered research to the personalized email landing in a subscriber's inbox. It covers how company/person/event intelligence is stored, refreshed, and delivered, and closes with an assessment of what works well and what a B2B telecom salesperson would actually need.

---

## 1. System Overview

Two repositories collaborate to produce and deliver intelligence reports:

- **`sales-recon`** — Runs the OpenClaw AI agent ("Symphony Signal"), manages the research memory, and hosts the cron scheduler
- **`event-planner`** — Manages subscriptions, stores reports, composes and sends personalized emails

```
┌─────────────────────────────────────────────────────────────────┐
│  SCHEDULER  (event-planner-cron.py)                             │
│  Runs once to register a weekly cron job inside OpenClaw        │
│  Tuesday 06:00 CT  →  openclaw.mjs cron add                     │
└───────────────────────────┬─────────────────────────────────────┘
                            │ fires weekly
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  OPENCLAW AGENT  (sales-recon-openclaw container)               │
│  Model: Gemini 3-Flash (primary), Kimi K2.5 / Minimax fallback  │
│  Session: isolated  │  Tools: web_search, web_fetch, exec, I/O  │
│                                                                 │
│  Step 1  GET /api/intelligence/targets  ──────────────────────► │─┐
│  Step 2  Research each target + update memory/*.md              │ │
│  Step 3  Build JSON payload                                     │ │
│  Step 4  POST /api/webhooks/intel-report  ─────────────────────►│─┘
└─────────────────────────────────────────────────────────────────┘
         │ GET targets           │ POST intel-report
         ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  EVENT PLANNER  (Next.js app)                                   │
│  /api/intelligence/targets  →  returns subscribed entities      │
│  /api/webhooks/intel-report →  stores reports, sends emails     │
│                                                                 │
│  Per active subscriber:                                         │
│    match targets → compose HTML email (Gemini) → SMTP send      │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
                   Subscriber's inbox
                (personalized HTML email)
```

---

## 2. Trigger: Cron Job Setup

**File:** `event-planner-cron.py`

This Python script is run once (manually, or via `deploy-prod.sh`) to register a recurring cron job inside the live `sales-recon-openclaw` Docker container. It is not a daemon — it configures the scheduler and exits.

### Schedule

```python
jobs_to_add = [
    ("market-intelligence-tuesday", "0 6 * * 2"),
    # ("market-intelligence-thursday", "0 6 * * 4"),  # commented out
]
```

Currently fires every **Tuesday at 06:00 CT**. Thursday is commented out.

### How Job Registration Works

1. **Load `.env`** — Reads `CRON_EVENT_PLANNER_DNS` (the event-planner URL) and `CRON_SECRET_KEY` (shared Bearer token) from the project `.env` file.
2. **Remove existing jobs** — Lists all cron jobs inside the container via `openclaw.mjs cron list`. Any job whose name starts with the first 20 characters of a target job name is removed. This makes registration idempotent (safe to re-run).
3. **Add new job** — Calls `openclaw.mjs cron add` with:
   - `--name market-intelligence-tuesday`
   - `--cron "0 6 * * 2"`
   - `--agent main` (the "Symphony Signal" agent)
   - `--message <full CRON_MSG prompt>` (see §3)
   - `--session isolated` (fresh context per run, no bleed between weekly runs)
   - `--tz America/Chicago`
   - `--best-effort-deliver`

The job is stored inside OpenClaw's internal scheduler. When it fires, OpenClaw creates an isolated agent session and feeds it the `CRON_MSG` prompt as the opening user message.

---

## 3. OpenClaw Agent Execution

**Container:** `sales-recon-openclaw`  
**Config:** `openclaw-data/openclaw.json`  
**Agent:** "Symphony Signal" (alias "Kenji"), ID `main`

### Model Stack

| Priority | Model | Alias | Notes |
|----------|-------|-------|-------|
| Primary | `google/gemini-3-flash-preview` | kenji | Fast, cost-efficient |
| Fallback 1 | `google/gemini-3.1-flash-lite-preview` | — | Lighter fallback |
| Fallback 2 | `moonshot/kimi-k2.5` | reasoner | 256k context |
| Fallback 3 | `minimax/MiniMax-M2.7` | deep-thinker | 200k, reasoning-optimized |

### Tools Available in Cron Sessions

| Tool | Provider | Use |
|------|----------|-----|
| `web_search` | Brave Search API | Research companies, people, events |
| `web_fetch` | Firecrawl | Crawl JS-heavy pages |
| `exec` | Shell (curl allowlisted only) | Call event-planner API endpoints |
| `read_file` / `write_file` / `edit_file` | Filesystem | Read and update memory files |

The `web_fetch` tool is explicitly **prohibited** in the cron prompt for the API calls (SSRF protection). `exec` with `curl` is used instead.

### Session Isolation

Each run is `--session isolated`, meaning the agent starts with no conversation history from previous runs. However, it has full access to the shared **workspace filesystem** — the memory files written by previous runs are always present.

---

## 4. Step 1 — Fetch Targets

**Endpoint:** `GET {CRON_EVENT_PLANNER_DNS}/api/intelligence/targets`  
**Auth:** `Authorization: Bearer {CRON_SECRET_KEY}`

The agent runs:

```bash
curl --fail-with-body --show-error --max-time 30 \
  -H "Authorization: Bearer {CRON_SECRET_KEY}" \
  "{CRON_EVENT_PLANNER_DNS}/api/intelligence/targets"
```

### Response Structure

```json
{
  "generatedAt": "2026-04-08T11:00:00.000Z",
  "companies": [
    { "name": "Nokia", "pipelineValue": 500000, "subscriptionCount": 3 }
  ],
  "attendees": [
    { "name": "Timo Ihamuotila", "title": "CFO", "company": "Nokia",
      "seniorityLevel": "C-Suite", "subscriptionCount": 2 }
  ],
  "events": [
    { "name": "FutureNet World 2026", "startDate": "2026-04-21",
      "endDate": "2026-04-22", "status": "CONFIRMED",
      "subscriptionCount": 4,
      "linkedAttendees": [
        { "name": "Timo Ihamuotila", "title": "CFO", "company": "Nokia" }
      ]
    }
  ]
}
```

Only entities with `subscriptionCount > 0` are returned, ordered by subscription count descending (most-watched first).

### Fatal Error Handling

If the curl exit code is non-zero, or the response is not valid JSON, the agent prints a `FATAL ERROR:` message and **stops immediately** — no research, no delivery.

---

## 5. Step 2 — Research Each Target

This is the core intelligence-gathering step. The agent processes companies, attendees, and events in sequence.

### Memory Storage (gbrain)

Research is persisted in the **gbrain** knowledge brain — Postgres+pgvector
running in the `sales-recon-postgres` container, exposed to the agent through
the `gbrain` MCP server registered in `openclaw-data/mcporter.json`. The
legacy `openclaw-data/workspace/memory/*.md` directory is no longer the
source of truth; it remains read-only for a short transition window only.

Slug convention (used for `gbrain.get_page` / `gbrain.put_page`):

- companies → `companies/<slug>` (e.g. `companies/nokia`)
- people → `people/<slug>` (e.g. `people/timo-ihamuotila`)
- events → `events/<slug>` (e.g. `events/futurenet-world-2026`)

Slugs are lowercase and hyphenated. The Rakuten Symphony capability page
lives at `companies/rakuten-symphony` and is retrieved via `gbrain.query`
rather than read as a single file.

### Page Body and Timeline

Each page stores a markdown body (free-form profile / decision makers /
narrative) plus a structured `timeline_entries` table — each entry has
`{date, source, detail}`. New dated findings are added as timeline entries
on every `gbrain.put_page` call. There is no longer a `## Latest` /
`## Archive` split; recency is encoded in `timeline_entries.date` and
surfaced via gbrain's recency boost during search.

The `[FRICTION]` tag is still prepended to any timeline detail that
identifies a hardware-cycle dependency, proprietary lock-in, integration
complexity, or legacy architecture — these are explicit sales opportunity
signals and gbrain ranks them via the salience boost.

Example timeline entry:

```json
{
  "date": "2026-04-08",
  "source": "https://example.com/nokia-ai-ran",
  "detail": "[FRICTION] Nokia's AI-RAN roadmap requires dedicated Marvell OCTEON silicon; software-defined alternatives not yet qualified on their preferred hardware"
}
```

### Freshness Check

Before any web search, the agent calls `gbrain.get_page(slug)`. If
`page.updated_at` is within the **last 48 hours**, the target is marked
`skipped-fresh` and no web search is run. The page contents are still
available for payload construction.

### Auto-Linking and Maintenance

Every `gbrain.put_page` call auto-extracts entity references from the body
and reconciles typed links (`works_at`, `attended`, `mentions`) without any
explicit link tool call from the agent. The nightly `gbrain cycle run`
(registered via `event-planner-cron.py` as `gbrain-dream-cycle-nightly`)
handles embedding refresh, salience recompute, soft-delete purge, and
overnight synthesis. There is no manual archive rotation or 150-line trim.

### Per-Company Research

```
Query: "<Company> telecom B2B strategy announcements 2026"
Freshness: "pw" (past week)
Max searches: 2 (second only if exec change, acquisition, or major product launch detected)
```

Synthesis focus: what changed, why it matters to Rakuten Symphony's radio / cloud / automation portfolio.

### Per-Attendee Research

```
Query: "<Full Name> <Company> role news 2026"
Freshness: "pw"
Max searches: 1
```

Synthesis focus: role changes, announcements, strategic signals relevant to Rakuten Symphony.

### Per-Event Research

```
Query: "<Event Name> 2026 agenda keynotes exhibitors"
Freshness: "pw"
Max searches: 1
```

For events, the agent also individually researches each attendee listed in `event.linkedAttendees[]` — applying the same freshness check per person.

### Memory Update Protocol

After research, the agent calls `gbrain.put_page` with:

1. The slug (`companies/<slug>` etc.)
2. The full markdown body (profile / decision makers / narrative — gbrain
   computes the diff against the previous version internally; the agent
   sends the latest complete body)
3. A `timeline_entries` array containing only the **new** dated findings

gbrain's write path is transactional, so partial-write data loss is not
possible. On a tool error, retry once; if it fails again, log the error and
continue to the next target — do not abort the run.

---

## 6. Step 3 — Build the JSON Payload

Before generating any sales angles, the agent calls `gbrain.query("Rakuten Symphony capabilities relevant to <target>")`. gbrain's hybrid search (BM25 + vector + graph + recency) returns the most relevant chunks of the `companies/rakuten-symphony` page (and any related concept pages) ranked for the specific target — this replaces reading a single static `memory/Rakuten_Symphony.md` file.

### Per-Target Fields

| Field | Content |
|-------|---------|
| `type` | `"company"`, `"attendee"`, or `"event"` |
| `name` | Exact name from the targets response |
| `summary` | 2–3 sentence update on what changed |
| `salesAngle` | 1 sentence naming a specific RS initiative vs. this target's current situation |
| `fullReport` | Full markdown of the updated `## Latest` section only |

### Sales Angle Quality Rule

The prompt enforces that `salesAngle` must be concrete:

> **Bad:** "Rakuten Symphony's automation platform could help this company."
>
> **Good:** "Following Nokia's March 2026 AI-RAN hardware dependency announcement, Rakuten Symphony's software-defined OSS (per Mar 10 satellite OSS launch) offers a direct path off the hardware refresh cycle."

If the target's memory file contains a `[FRICTION]` bullet, the sales angle is expected to reference that specific pain point.

### Payload Structure

```json
{
  "runId": "2026-04-08-cron",
  "timestamp": "2026-04-08T11:05:23.000Z",
  "updatedTargets": [
    {
      "type": "company",
      "name": "Nokia",
      "summary": "Nokia announced a new AI-RAN silicon partnership...",
      "salesAngle": "Nokia's Marvell OCTEON dependency (flagged Apr 8) creates a...",
      "fullReport": "## Latest\n- **2026-04-08** — ..."
    }
  ]
}
```

Only targets where **new intelligence was found** are included. Fresh-skipped targets are omitted. If no targets were updated, `updatedTargets` is an empty array and the webhook still fires.

---

## 7. Step 4 — Deliver to Event Planner

The agent writes the payload to `/tmp/intel-report.json` and then runs:

```bash
curl --fail-with-body --show-error --max-time 30 \
  -X POST \
  -H "Authorization: Bearer {CRON_SECRET_KEY}" \
  -H "Content-Type: application/json" \
  -d @/tmp/intel-report.json \
  "{CRON_EVENT_PLANNER_DNS}/api/webhooks/intel-report"
```

If the curl exit code is non-zero, the agent prints a `FATAL ERROR:` message and exits with error status (the run is not marked successful). The temp file is deleted regardless of success or failure.

---

## 8. Event Planner Webhook Processing

**File:** `event-planner/app/api/webhooks/intel-report/route.ts`

### Step 8a — Store Reports

Each target in `updatedTargets` is upserted into the `IntelligenceReport` table with a composite unique key `(runId, targetName)`. Re-sending the same runId is idempotent.

```
IntelligenceReport
  runId        e.g. "2026-04-08-cron"
  targetType   "company" | "attendee" | "event"
  targetName   exact name
  summary      2–3 sentence update
  salesAngle   1 sentence
  fullReport   full markdown of ## Latest
  createdAt
```

### Step 8b — Fetch Upcoming Events

The webhook fetches all non-CANCELED events with a start date within the next 30 days. These appear in the email's event calendar section.

### Step 8c — Match Targets to Subscribers

For each active `IntelligenceSubscription`, the webhook identifies which updated targets are relevant to that subscriber via two matching categories:

| Category | Logic |
|----------|-------|
| **Highlighted** | Target is in the subscriber's directly selected companies or attendees |
| **Event-linked** | Target is an attendee or company associated with a subscribed event |

Targets that match neither category are excluded from that subscriber's email.

### Step 8d — Compose & Send Email

For each subscriber with at least one matched target:

1. **AI composition** — `lib/intelligence-email.ts` sends the matched targets + upcoming events to Gemini (configured as `google/gemini-3.1-flash-lite-preview` in event-planner) with a prompt to produce a personalized HTML email.
2. **SMTP send** — `lib/email.ts` sends via Nodemailer with configurable SMTP host/port/auth.
3. **Log** — An `IntelligenceEmailLog` row is written: `{ runId, userId, email, targetCount, status: 'sent' }`.

Additionally, an **aggregate email** is sent to Root/Marketing users containing all updated targets organized by type (Companies, Attendees, Events), with no unsubscribe link.

---

## 9. Email Structure — What the Subscriber Receives

The email is AI-generated prose from a structured data prompt. The AI is instructed:

- First line must be `Subject: <subject>`
- Personalized opening sentence addressing the recipient by name
- Directly tracked targets first, marked with ⭐
- Event-linked targets grouped by event name
- Per target: `<h3>` heading, 2–3 bullet points, Sales Angle in `<blockquote>`
- Upcoming events as `<table>` (30-day window)
- One-click unsubscribe footer (token-based, redirects to `/intelligence/subscribe?unsubscribed=true`)
- Tone: sharp B2B sales, no fluff, maximum 800 words

### Approximate Email Layout

```
Subject: Your Market Intelligence Briefing — Nokia, Ericsson, FutureNet World

Hi [Name],

Here are your tracked intelligence updates as of April 8, 2026.

────────────────────────────────────────
⭐ YOUR DIRECTLY TRACKED TARGETS
────────────────────────────────────────

Nokia
• AI-RAN silicon partnership with Marvell announced; requires dedicated OCTEON hardware
• CFO Timo Ihamuotila flagged capex review for H2 2026
• Open RAN deployment slowed in North America; proprietary stack preferred in EU

> Sales Angle: Nokia's OCTEON dependency (Apr 8) creates an opening for
> Rakuten Symphony's software-defined OSS, which was extended to satellite
> networks in the Mar 10 launch — a direct path off the hardware refresh cycle.

────────────────────────────────────────
FROM YOUR TRACKED EVENTS: FutureNet World 2026 (Apr 21–22, London)
────────────────────────────────────────

Timo Ihamuotila — CFO, Nokia
• ...

────────────────────────────────────────
UPCOMING EVENTS (next 30 days)
────────────────────────────────────────
| Event              | Date       | Status    |
|--------------------|------------|-----------|
| FutureNet World    | Apr 21–22  | CONFIRMED |
| GITEX Global 2026  | May 7–10   | PIPELINE  |

────────────────────────────────────────
Unsubscribe | You're receiving this because you subscribed at eventplanner.app
```

---

## 10. Subscription Management — User Side

**UI:** `/intelligence/subscribe` page in the event-planner Next.js app

Users manage three selection types:

- **Companies** — Subscribe to a company entity
- **Attendees** — Subscribe to a specific person
- **Events** — Subscribe to an event (automatically surfaces all linked attendees)

When a user subscribes to an entity, the entity's `subscriptionCount` is incremented. When they unsubscribe, it is decremented (never below 0). The cron agent only fetches and researches entities with `subscriptionCount > 0`, so the research workload scales exactly with subscriber activity.

Each user has one `IntelligenceSubscription` record with an `unsubscribeToken` (CUID). The one-click unsubscribe endpoint sets `active = false` on that record, stopping all future emails to that user without deleting their selections.

---

## 11. Data Persistence and Refresh Cycle

### Memory File Lifecycle

```
Weekly cron fires
       │
       ▼
For each target: read memory/{Name}.md
       │
  ┌────┴────────────────────────────────┐
  │ Entry in ## Latest < 48h old?       │
  │                                     │
  YES → skip web_search                NO → run web_search(es)
  │     mark "skipped-fresh"            │   synthesize findings
  │                                     │   prepend to ## Latest
  │                                     │   rotate old → ## Archive
  └────┬────────────────────────────────┘
       │
       ▼
memory/{Name}.md persisted on Docker volume
(survives container restarts and redeployments)
```

### Volume Mounts

```yaml
volumes:
  - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
  - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
```

The host paths (`openclaw-data/` and `openclaw-data/workspace/`) are gitignored and persist independently of container lifecycle.

### Audit Trail

Each cron run appends a summary entry to `memory/YYYY-MM-DD.md`:

```markdown
## Performance Log
- 06:07 market-intelligence cycle
- targets fetched: 5 companies, 3 attendees, 2 events
- researched: Nokia, Ericsson, Timo Ihamuotila, FutureNet World 2026
- skipped (fresh): AT&T, Verizon, Meredith Whittaker
- POST status: 200
- total: ~8m
```

These daily log files accumulate in `memory/` and are archived when they exceed 50 lines.

---

## 12. Recommendations for B2B Telecom Salespeople

### What the Current System Does Well

**Structured memory with `[FRICTION]` tagging** is the strongest feature. Identifying hardware-cycle dependency, proprietary lock-in, and integration complexity as explicit named signals is exactly the framing a telecom infrastructure seller needs — these are where RS displaces incumbents.

**Concrete sales angles** tied to specific RS capabilities (not generic "our platform can help") set a high bar. The prompt explicitly rejects generic angles and requires naming a real RS product or announcement.

**Event-linked targeting** is smart and directly actionable. A sales rep heading to FutureNet World gets a briefing on every tracked attendee who will be at that event. This is the highest-value use case.

**48-hour freshness checks** avoid redundant API calls and keep the agent fast, while ensuring the report always reflects the latest available intelligence.

---

## Key Files Reference

| File | Location | Role |
|------|----------|------|
| `event-planner-cron.py` | `sales-recon/` | Registers weekly cron job in OpenClaw |
| `openclaw.json` | `sales-recon/openclaw-data/` | Agent model/tool configuration |
| `MEMORY.md` | `sales-recon/openclaw-data/workspace/` | Long-term curated agent context |
| `memory/*.md` | `sales-recon/openclaw-data/workspace/memory/` | Per-entity research files (44 files) |
| `targets/route.ts` | `event-planner/app/api/intelligence/` | Returns subscribed targets to agent |
| `intel-report/route.ts` | `event-planner/app/api/webhooks/` | Receives payload, stores, sends emails |
| `intelligence-email.ts` | `event-planner/lib/` | AI-composed HTML email logic |
| `email.ts` | `event-planner/lib/` | Nodemailer SMTP delivery |
| `schema.prisma` | `event-planner/prisma/` | DB schema for all intelligence models |
