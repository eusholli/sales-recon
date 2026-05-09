# HEARTBEAT.md - Kenji Active Tasks

When a heartbeat event occurs, do the following to proactively keep gbrain fresh.

## Dynamic Intelligence Scan (gbrain-backed)

1. Use `gbrain.query` to find 3–5 stalest target pages under `companies/`, `people/`, or `events/` (oldest `updated_at` first). Do NOT scan the `memory/` directory — research no longer lives there.
2. For each chosen target, run ONE `web_search` for recent telecom news, strategy updates, or executive announcements. Respect the global 5-searches-per-session cap and the 2-second sequential spacing.
3. For any new findings, call `gbrain.put_page(slug, ...)` with updated body and `timeline_entries` for any newly dated facts. gbrain handles linking, embeddings, and salience automatically — no manual pruning, no append-only files.
4. If you detect any friction points (vendor lock-in, hardware cycles, deployment delays) with competitors like Nokia or Ericsson, prefix the relevant `timeline_entries.detail` with `[FRICTION]`.

**Do NOT POST the event-planner webhook from a heartbeat.** Heartbeats refresh gbrain only; the scheduled cron is the channel that emails sales reps.

Do not use heartbeats to email or post externally. Reply with `HEARTBEAT_OK` when finished, unless a catastrophic failure occurs which should be explicitly logged.
