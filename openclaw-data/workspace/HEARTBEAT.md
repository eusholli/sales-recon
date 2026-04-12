# HEARTBEAT.md - Kenji Active Tasks

When a heartbeat event occurs, do the following to proactively gather intelligence:

## Dynamic Intelligence Scan
1. Use `list_dir` or read through the contents of your `memory/` directory to discover the current watch targets.
2. Select 3-5 existing `.md` target files (e.g., companies, people) that haven't been updated recently.
3. Perform a `web_search` for recent telecom news, strategy updates, or executive announcements for each chosen target. (Respect the global 5 searches max limit per session).
4. For any new findings, `read_file` the target's memory and append a timestamped block to it.
5. Auto-Prune: If you find a file exceeds 150 lines, take the oldest 100 lines, summarize it into a small block at the top, and delete the rest of those lines before appending the new result.
6. If you detect ANY friction points (vendor lock-in, hardware cycles, deployment delays) with competitors like Nokia or Ericsson, prepend `[FRICTION]` to the entry.

Do not use heartbeats to email or post externally. Reply with `HEARTBEAT_OK` when finished, unless a catastrophic failure occurs which should be explicitly logged.
