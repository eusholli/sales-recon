# 🧠 MEMORY.md - Your Long-Term Memory

This file is for your curated, distilled memories, decisions, and high-level operational standards.

## Intelligence Report Standard (Updated Feb 15, 2026)
When asked for an "updated intelligence report" on a company, the response MUST be structured into two main sections:
1.  **Company Focus (Current Intelligence):** Summarizing the latest operational/product announcements.
2.  **Key Decision Makers:** A table listing the primary executives. This table must contain the following columns: Name, Responsibilities, and Most Recent Public Topic (the subject of their latest known public statement or the key area of their responsibility if a recent topic is unavailable).

## Research Protocol (Updated 2026-03-02)
**Tools:**
- `web_search` — PRIMARY tool. Uses Gemini Google Search Grounding (fast, ~2–5s, AI-synthesised with citations). Replaces Grok/Tavily.
- `web_fetch` — fetch and extract a specific URL.

**Workflow:**
1. Deep dive / full profile → ONE `web_search` with comprehensive query. Add a second targeted call only if needed. Max 2 calls.
2. Quick news → ONE `web_search` with freshness filter.
3. URL content → `web_fetch`.
4. **Save to memory:** Write findings to `memory/{Target}.md` after each session.

**Key rules:** Max 2 `web_search` calls per task. One well-formed query covers what used to need 3 serial searches. Never use Grok/xAI (removed — was 30s/call).

## Cross-Reference Rule (Updated Feb 18, 2026)
When you discover a new person at a company (exec, key player, event speaker), you MUST:
1.  **Create/update their memory file:** `memory/{First_Name}_{Last_Name}.md` with profile, role, recent activity.
2.  **Add to company intelligence:** Update the Key Decision Makers table in the company's memory file with their name, responsibilities, and most recent public topic.
3.  **Cross-link events:** When that person speaks at or hosts an event (MWC, webinars, etc.), add the event to both their file AND the company's file.

This ensures relationships between **companies ↔ people ↔ events** are always interconnected in your memory.

## Rakuten Symphony Naming Standards (Updated Feb 25, 2026)
When reporting on Rakuten Symphony, **DO NOT** use old "SymXXX" product naming (e.g., Symworld, Symview, Symplan). This naming has been replaced with descriptive names.
- Replace **Symworld** with **Rakuten Symphony industrial marketplace** or **network orchestration platform**.
- Use descriptive terms for all other former "Sym" products (e.g., "network observability" instead of Symview).
- Always check generated responses to ensure no "Sym" branded product names remain.

## Response Reliability Standard (Added 2026-03-06)
Every research task must conclude with a comprehensive delivery of the findings. If a task is complex, you may provide incremental status updates, but the final response in that session must contain the full synthesized report. Do not expect the user to hunt for files or wait for a subsequent session for the core value; deliver the intelligence directly.

## Memory Hygiene Protocol (Added 2026-03-01)

### Topic File Structure
All memory/{Target}.md files must follow this three-section structure:
- `## Latest` — max 3 recent updates, max 50 lines. Always load.
- `## Profile` — static bio/background. Max 30 lines. Always load.
- `## Archive` — older entries. Only load when explicitly asked.

### File Size Guidance
- memory/{Target}.md: soft cap ~150 lines (flag to user if exceeded)
- MEMORY.md: hard cap 200 lines (OpenClaw truncates after this)
- Daily session files: compress to 5-bullet summary after 48h via heartbeat

### Session Load Policy
Load at session start: today's + yesterday's daily files only.
All other daily files: skip unless user asks.
Topic files: load on-demand per target mentioned, not all upfront.
