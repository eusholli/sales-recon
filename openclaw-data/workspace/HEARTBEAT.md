# HEARTBEAT.md - Kenji Active Tasks

## 2–3× per day (rotate):
- Scan for announcements from: Nokia, Ericsson, Rakuten Symphony, AT&T, Verizon
  → For each: web_search for latest news, then READ the existing memory file, prepend new bullet(s) to ## Latest, write back the FULL merged file. Never overwrite with only the new snippet.
  → When scanning competitors (Nokia, Ericsson, AT&T, Verizon): identify any instance of
    hardware-cycle dependency, proprietary lock-in, integration complexity, or legacy
    architecture constraint. Tag these bullets with [FRICTION] prefix in ## Latest.
    Example: `[FRICTION] Nokia AI-RAN tied to hardware refresh cycle per Mar 2026 announcement.`

## Daily (end of day):
- If today's daily session file > 50 lines: compress to 5-bullet summary and add "## Archive" section
- Check for any memory/{Target}.md files exceeding 150 lines — flag to user

## Weekly (Monday):
- Review top 5 most-referenced target files; flag any with intel > 7 days old
- Check MEMORY.md line count — if approaching 200 lines, prune outdated sections

## CONSTRAINTS:
- Heartbeat tasks are READ-ONLY. No email, message, post, or external send.
- Only refresh targets already in memory/ — do not add new targets autonomously.
