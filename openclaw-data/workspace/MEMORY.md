# 🧠 MEMORY.md - Your Long-Term Memory

This file defines how you store ongoing intelligence. 

## Memory Hygiene & Auto-Pruning
- All target profiles are stored in `memory/{Target_Name}.md` (spaces replaced by underscores).
- **Append-Only Format**: When you research a target, append your new findings at the BOTTOM of the file with the current date. Example: `\n## [2026-04-12]\n- Found X, Y, Z.`
- **No Rigid Sections**: Do NOT use `## Latest`, `## Profile`, or `## Archive`. We use a simple timestamped event log.
- **Auto-Prune Rule**: If a file exceeds 150 lines, automatically summarize the oldest lines into a single concise paragraph at the top, and remove the raw outdated lines. Keep your context window clean.

## Important Associations
- Companies ↔ People ↔ Events: If you find an exec speaking at an event, try to update both the company file and the exec file if you have both contexts.

## Specific Naming Rules
- Rakuten Symphony product naming: DO NOT use old "SymXXX" terms (e.g. Symworld). Use descriptive terms like "network orchestration platform".
- Ensure any synthesized responses for intelligence updates map specific Rakuten Symphony capabilities directly to the target's current pain points.

## Database Sync for Full Briefs
**CRITICAL — Do this IMMEDIATELY after writing or updating a memory file, BEFORE any other steps (daily log updates, summaries, etc.).** Push the research to the database so the full brief is available in the UI. Do not let a failed daily log edit or any other secondary task delay or skip this step.

**Step 1 — Build payload** (same format as the cron job, but `silent: true`):
```json
{
  "runId": "YYYY-MM-DD-adhoc",
  "timestamp": "<ISO 8601 now>",
  "silent": true,
  "updatedTargets": [
    {
      "type": "company" | "attendee" | "event",
      "name": "<exact entity name as it appears in the memory file>",
      "summary": "<2–3 sentence update>",
      "salesAngle": "<1 sentence mapping target situation to a specific Rakuten Symphony capability>",
      "recommendedAction": "<1-sentence time-sensitive next step, or omit if no clear trigger>",
      "fullReport": "<the new timestamped findings you just wrote to the memory file>"
    }
  ]
}
```
- `type`: use `"company"` for corporate entities, `"attendee"` for individual people, `"event"` for conferences/events.
- `name`: use the exact name from the memory filename (underscores replaced with spaces).
- `runId`: use today's date in `YYYY-MM-DD-adhoc` format.

**Step 2 — Deliver**:
Use `write_file` to write the payload to `/tmp/intel-report-adhoc.json`, then use `exec` to run:
```
python3 workspace/sync_db.py /tmp/intel-report-adhoc.json
```
If delivery fails, output a bold **FATAL database sync error** with the python output. Never fail silently.
