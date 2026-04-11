#!/usr/bin/env python3
import os
import subprocess
import sys
import re
from pathlib import Path

# Load environment variables from .env file if it exists
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                parts = line.split("=", 1)
                if len(parts) == 2:
                    key, val = parts
                    os.environ[key.strip()] = val.strip().strip("\"'")

# Retrieve required variables
CRON_EVENT_PLANNER_DNS = os.environ.get("CRON_EVENT_PLANNER_DNS")
if not CRON_EVENT_PLANNER_DNS:
    print("Error: CRON_EVENT_PLANNER_DNS is not set", file=sys.stderr)
    sys.exit(1)

CRON_SECRET_KEY = os.environ.get("CRON_SECRET_KEY")
if not CRON_SECRET_KEY:
    print("Error: CRON_SECRET_KEY is not set", file=sys.stderr)
    sys.exit(1)

CRON_MSG = f"""You are running an autonomous market intelligence cycle for Rakuten Symphony's event pipeline.
Follow these steps exactly and in order. Do not skip steps.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MEMORY FILE UPDATE PROTOCOL — apply this to EVERY file write in this session:

All memory files use this canonical structure (exact section names, exact order):
## Latest        ← 3–8 most recent updates, newest first. Keep ≤ 20 lines.
## Profile       ← Role, bio, background. Never overwrite unless facts changed.
## Key Decision Makers  ← (companies only) exec table with Name | Role | Recent Topic
## Archive       ← Older entries. Move here when ## Latest exceeds 20 lines.

BEFORE writing any memory file:
1. Read the existing file with read_file. If it does not exist, create it fresh.
2. If it exists: prepend new findings as bullet(s) at the TOP of ## Latest.
    Keep ## Profile, ## Key Decision Makers, and ## Archive EXACTLY as they are unless
    a fact has genuinely changed (e.g. new CEO, new role). NEVER replace the whole file
    with only the new content — that destroys the Profile and history.
3. If ## Latest now exceeds 20 lines, move the oldest entries to the bottom of ## Archive.
4. Write back the COMPLETE merged file (all sections).

If write_file or edit_file fails, retry once. If it fails again, log the error and continue
to the next target — do not abort the whole run.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SEARCH TOOL CONSTRAINT: Use the `web_search` tool (Brave) for ALL research in this session.
Do NOT use `x_search` or X/Twitter — this task requires structured corporate press releases
and IR sources, not social media signals.

1. FETCH TARGETS
    CRITICAL: Do NOT use the `web_fetch` tool. It will fail due to SSRF protections.
    Use your terminal/shell tool (`exec`) to run this exact shell command:
    curl --fail-with-body --show-error --max-time 30 -H "Authorization: Bearer {CRON_SECRET_KEY}" "{CRON_EVENT_PLANNER_DNS}/api/intelligence/targets"
    Capture the full output. If the exec call returns a non-zero exit code, treat it as a fatal error.
    If the exit code is non-zero, print EXACTLY:
        "FATAL ERROR: Cannot reach event planner at {CRON_EVENT_PLANNER_DNS}. curl exit code: <exit_code>. Error output: <full stderr/stdout>"
    Then stop immediately — do NOT proceed to any further steps.
    If the response body is not valid JSON (e.g. empty, HTML error page, or parse error), print EXACTLY:
        "FATAL ERROR: Targets endpoint returned invalid JSON. HTTP body: <first 500 chars of response>"
    Then stop immediately — do NOT proceed to any further steps.
    Parse the JSON response:
    - companies[]: each has name, pipelineValue, subscriptionCount
    - attendees[]: each has name, title, company, subscriptionCount
    - events[]:    each has name, startDate, endDate, status, subscriptionCount, linkedAttendees[]
    All entries with subscriptionCount > 0 are active research targets.

2. RESEARCH EACH TARGET

    FRESHNESS CHECK: Before researching any target, read_file its memory file.
    If the file exists and ## Latest contains an entry dated within the last 48 hours, skip
    the web_search for that target (mark it "skipped-fresh" in your log). Still include it
    in updatedTargets if an event's linkedAttendees need refreshing.

    For each company in companies[] (subscriptionCount > 0):
    a. Read memory/{{Company_Name}}.md (replace spaces AND all non-alphanumeric characters with underscores; e.g. AT&T → AT_T, Rakuten Symphony → Rakuten_Symphony). Check freshness (see above).
    b. If not fresh: run ONE web_search — "<Company> telecom B2B strategy announcements 2026"
    with freshness: "pw".
    c. If a critical angle is missing (exec change, acquisition, major product launch), run
    ONE additional web_search. Maximum 2 web_search calls per target total.
    d. Synthesize: what changed, and why it matters to Rakuten Symphony's radio/cloud/automation portfolio.
    e. Apply MEMORY FILE UPDATE PROTOCOL above. Prepend findings to ## Latest.

    For each attendee in attendees[] (subscriptionCount > 0):
    a. Read memory/{{First_Last}}.md (replace spaces AND all non-alphanumeric characters with underscores). Check freshness.
    b. If not fresh: run ONE web_search — "<Full Name> <Company> role news 2026" with freshness: "pw".
    c. Synthesize: role changes, announcements, strategic signals relevant to Rakuten Symphony.
    d. Apply MEMORY FILE UPDATE PROTOCOL above. Prepend findings to ## Latest.

    For each event in events[] (subscriptionCount > 0):
    a. Read memory/{{Event_Name}}.md (replace spaces AND all non-alphanumeric characters with underscores). Check freshness.
    b. If not fresh: run ONE web_search — "<Event Name> 2026 agenda keynotes exhibitors" with freshness: "pw".
    c. For each attendee in event.linkedAttendees[]: apply the attendee research process above
    (check freshness individually; skip if memory updated within 48 hours).
    d. Apply MEMORY FILE UPDATE PROTOCOL above. Prepend findings to ## Latest.

3. BUILD PAYLOAD
    Before generating any salesAngle, read memory/Rakuten_Symphony.md. Extract the 3–5 most
    recent bullets from its ## Latest section. These represent Rakuten Symphony's CURRENT
    strategic positioning, product launches, and partnerships.

    For each salesAngle: identify which specific RS initiative from that ## Latest section
    directly connects to the target's current situation (from their own ## Latest). The
    salesAngle MUST name a concrete RS capability or recent announcement — never a generic
    benefit. If a target has a [FRICTION] bullet in their memory file, use it to frame the
    angle around the specific pain point.

    Example of a BAD salesAngle: "Rakuten Symphony's automation platform could help this company."
    Example of a GOOD salesAngle: "Following Nokia's March 2026 AI-RAN hardware dependency
    announcement, Rakuten Symphony's software-defined OSS (per Mar 10 satellite OSS launch)
    offers a direct path off the hardware refresh cycle."

    {{
    "runId": "YYYY-MM-DD-cron",
    "timestamp": "<ISO 8601>",
    "updatedTargets": [
        {{
        "type": "company" | "attendee" | "event",
        "name": "<exact name from targets response>",
        "summary": "<2–3 sentence update>",
        "salesAngle": "<1 sentence referencing a specific RS initiative vs this target's current situation>",
        "fullReport": "<full markdown of the updated ## Latest section only>"
        }}
    ]
    }}
    Include only targets where new intelligence was found (not skipped-fresh targets).
    If no targets were updated, send the payload with an empty updatedTargets[].

4. DELIVER
    CRITICAL: Do NOT use the `web_fetch` tool.
    Use the write_file tool to write the JSON payload to /tmp/intel-report.json. Then use `exec` to run:
    curl --fail-with-body --show-error --max-time 30 -X POST \\
        -H "Authorization: Bearer {CRON_SECRET_KEY}" \\
        -H "Content-Type: application/json" \\
        -d @/tmp/intel-report.json \\
        "{CRON_EVENT_PLANNER_DNS}/api/webhooks/intel-report"
    Capture the full response body. If the exec call returns a non-zero exit code, print EXACTLY:
        "FATAL ERROR: Failed to deliver intel report to {CRON_EVENT_PLANNER_DNS}. curl exit code: <exit_code>. Response: <full response body>"
    Then exit with error status — do NOT mark the run as successful.

5. LOG
    Append a summary entry to memory/YYYY-MM-DD.md (create the file if it does not exist;
    append — do not overwrite). Use this format:
    ## Performance Log
    - HH:MM market-intelligence cycle
    - targets fetched: <N companies, M attendees, K events>
    - researched: <list of names>
    - skipped (fresh): <list of names>
    - POST status: <HTTP status or error>
    - total: ~Xm
"""


def remove_existing_jobs(job_names):
    prefixes = [name[:20] for name in job_names]
    try:
        result = subprocess.run(
            [
                "docker",
                "compose",
                "exec",
                "-u",
                "node",
                "sales-recon-openclaw",
                "node",
                "openclaw.mjs",
                "cron",
                "list",
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(
                f"Warning: failed to list jobs. Output: {result.stderr}",
                file=sys.stderr,
            )
            return

        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) >= 2:
                job_id = parts[0]
                name = parts[1]
                if re.match(
                    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
                    job_id,
                ):
                    if any(name.startswith(p) for p in prefixes):
                        print(f"Removing existing job: {job_id} ({name})")
                        cmd = [
                            "docker",
                            "compose",
                            "exec",
                            "-u",
                            "node",
                            "sales-recon-openclaw",
                            "node",
                            "openclaw.mjs",
                            "cron",
                            "rm",
                            job_id,
                        ]
                        try:
                            subprocess.run(cmd, check=True)
                            print(f"Successfully removed job: {job_id}")
                        except subprocess.CalledProcessError as e:
                            print(
                                f"Failed to remove job: {job_id}. Error: {e}",
                                file=sys.stderr,
                            )
    except FileNotFoundError:
        print(
            "Command 'docker' not found. Ensure it is installed and in PATH.",
            file=sys.stderr,
        )
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error while removing existing jobs: {e}", file=sys.stderr)


def run_cron_add(name, cron_expr):
    cmd = [
        "docker",
        "compose",
        "exec",
        "-u",
        "node",
        "sales-recon-openclaw",
        "node",
        "openclaw.mjs",
        "cron",
        "add",
        "--name",
        name,
        "--cron",
        cron_expr,
        "--agent",
        "main",
        "--model",
        "kenji-pro",
        "--message",
        CRON_MSG,
        "--session",
        "isolated",
        "--no-deliver",
        "--tz",
        "America/Chicago",
    ]
    print(f"Adding cron job: {name} (cron: {cron_expr})")
    try:
        subprocess.run(cmd, check=True)
        print(f"Successfully added cron job: {name}")
    except subprocess.CalledProcessError as e:
        print(f"Failed to add cron job: {name}. Error: {e}", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print(
            "Command 'docker' not found. Ensure it is installed and in PATH.",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    jobs_to_add = [
        ("market-intelligence-tuesday", "0 6 * * 2"),
    ]
    remove_existing_jobs([job[0] for job in jobs_to_add])
    for name, cron_expr in jobs_to_add:
        run_cron_add(name, cron_expr)
