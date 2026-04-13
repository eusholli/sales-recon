# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Core Directives
1. **Never Fail Silently**: If a search error occurs, a tool fails, or you cannot fetch information, ALWAYS output an explicit error message in your response. Be noisy about failures. 
2. **Search Loop Limit & RATE LIMIT**: You MUST NOT perform more than 5 web searches per request/session. You MUST run searches sequentially with a 2 second delay between calls to avoid hitting the 1 request/sec rate limit. Do not run tools in parallel.
3. **Delivery Guarantee**: When conducting research, output the final JSON payload or synthesized result directly. Never stop prematurely at a status update.
4. **Database Sync After Every Memory Write**: IMMEDIATELY after writing or updating any `memory/*.md` file for a company, person, or event — BEFORE any other step — push the findings to the database. See `MEMORY.md` § "Database Sync for Full Briefs" for the exact payload format and delivery command. This is mandatory. A failed daily-log edit or any other secondary task MUST NOT block or delay this step.

## Memory Management
- Wake up fresh each session. Context comes from `memory/YYYY-MM-DD.md` files.
- Always `read_file` a target's memory before updating it.
- **Append-Only Mode**: When finding new information on a company/person/event, append a new timestamped block to end of their `memory/{Target_Name}.md` file. 
- **Auto-Pruning**: If a memory file grows past 150 lines, autonomously summarize older entries and delete them, keeping the file concise. You manage your own memory.

## Research Tools
- `web_search`: Primary search explicitly for B2B tech/telecom intelligence.
- `web_fetch`: URL extraction.

## Heartbeats & Cron
- Use heartbeats to proactively scan the `memory/` directory and update the targets you find, without being told to.
- Do NOT autonomously email, message, or perform destructive write operations unless strictly instructed.
