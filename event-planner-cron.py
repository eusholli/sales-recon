#!/usr/bin/env python3
import os
import subprocess
import sys
from pathlib import Path

# Load environment variables from .env file if it exists
env_path = Path(__file__).parent / '.env'
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                parts = line.split('=', 1)
                if len(parts) == 2:
                    key, val = parts
                    os.environ[key.strip()] = val.strip().strip('"\'')

# Retrieve required variables
CRON_EVENT_PLANNER_DNS = os.environ.get('CRON_EVENT_PLANNER_DNS')
if not CRON_EVENT_PLANNER_DNS:
    print("Error: CRON_EVENT_PLANNER_DNS is not set", file=sys.stderr)
    sys.exit(1)

CRON_SECRET_KEY = os.environ.get('CRON_SECRET_KEY')
if not CRON_SECRET_KEY:
    print("Error: CRON_SECRET_KEY is not set", file=sys.stderr)
    sys.exit(1)

CRON_MSG = f"""You are running an autonomous market intelligence cycle for Rakuten Symphony's event pipeline.
Follow these steps exactly:

1. FETCH TARGETS
   web_fetch GET {CRON_EVENT_PLANNER_DNS}/api/intelligence/targets
   Header: Authorization: Bearer {CRON_SECRET_KEY}
   Timeout: 5 minutes. If the request times out or returns an error, log the error and exit immediately.
   Parse the response:
   - companies[]: each has name, pipelineValue, subscriptionCount
   - attendees[]: each has name, title, company, subscriptionCount
   - events[]: each has name, startDate, endDate, status, subscriptionCount, linkedAttendees[]
   All entries with subscriptionCount > 0 are active research targets.

2. RESEARCH EACH TARGET
   For each company in companies[]:
   a. Check memory/{{Company_Name}}.md - if updated within 48 hours, skip it.
   b. Otherwise run ONE web_search: "<Company> telecom B2B strategy announcements 2026" with freshness:
"pw".
   c. If a second angle is missing (exec change, acquisition, spectrum), add ONE more web_search. Max 2
per target.
   d. Synthesize: what changed, and why it matters to Rakuten Symphony's radio/cloud/automation portfolio.
   e. Update memory/{{Company_Name}}.md with new findings.

   For each attendee in attendees[]:
   a. Check memory/{{Attendee_Name}}.md - if updated within 48 hours, skip it.
   b. Otherwise run ONE web_search: "<Attendee Name> <Company> role news 2026" with freshness: "pw".
   c. Synthesize: any role changes, announcements, or strategic signals.
   d. Update memory/{{Attendee_Name}}.md with new findings.

   For each event in events[]:
   a. Check memory/{{Event_Name}}.md - if updated within 48 hours, skip it.
   b. Otherwise run ONE web_search: "<Event Name> 2026 agenda keynotes exhibitors" with freshness:
"pw".
   c. Also research each attendee in event.linkedAttendees[] using the same attendee research process
above (skip if memory updated within 48 hours).
   d. Update memory/{{Event_Name}}.md with new findings.

3. BUILD PAYLOAD
   {{
     "runId": "YYYY-MM-DD-cron",
     "timestamp": "<ISO>",
     "updatedTargets": [
       {{
         "type": "company" | "attendee" | "event",
         "name": "<exact name from targets response>",
         "summary": "<2-3 sentence update>",
         "salesAngle": "<1 sentence: why this matters to RS portfolio>",
         "fullReport": "<full markdown>"
       }}
     ]
   }}
   Include only targets with new/updated intelligence.
   If no targets updated, send payload with empty updatedTargets[].

4. DELIVER
   web_fetch POST {CRON_EVENT_PLANNER_DNS}/api/webhooks/intel-report
   Header: Authorization: Bearer {CRON_SECRET_KEY}
   Timeout: 5 minutes. If the request times out or returns an error, log the error and exit immediately.
   Body: JSON payload from step 3.
   Confirm HTTP 200.

5. LOG
   Append summary to memory/YYYY-MM-DD.md:
   targets fetched, researched, skipped, POST status."""

def remove_existing_jobs(job_names):
    import re
    prefixes = [name[:20] for name in job_names]
    try:
        result = subprocess.run(
            ["docker", "compose", "exec", "-u", "node", "sales-recon-openclaw", "node", "openclaw.mjs", "cron", "list"],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"Warning: failed to list jobs. Output: {result.stderr}", file=sys.stderr)
            return

        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) >= 2:
                job_id = parts[0]
                name = parts[1]
                if re.match(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", job_id):
                    # Check if the job name matches one of our target jobs or its truncated version
                    if any(name.startswith(p) for p in prefixes):
                        print(f"Removing existing job: {job_id} ({name})")
                        cmd = ["docker", "compose", "exec", "-u", "node", "sales-recon-openclaw", "node", "openclaw.mjs", "cron", "rm", job_id]
                        try:
                            subprocess.run(cmd, check=True)
                            print(f"Successfully removed job: {job_id}")
                        except subprocess.CalledProcessError as e:
                            print(f"Failed to remove job: {job_id}. Error: {e}", file=sys.stderr)
    except FileNotFoundError:
        print("Command 'docker' not found. Ensure it is installed and in PATH.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error while removing existing jobs: {e}", file=sys.stderr)

def run_cron_add(name, cron_expr):
    cmd = [
        "docker", "compose", "exec", "-u", "node", "sales-recon-openclaw", "node", "openclaw.mjs", "cron", "add",
        "--name", name,
        "--cron", cron_expr,
        "--agent", "main",
        "--message", CRON_MSG,
        "--session", "isolated",
        "--tz", "America/New_York"
    ]
    print(f"Adding cron job: {name} (cron: {cron_expr})")
    try:
        subprocess.run(cmd, check=True)
        print(f"Successfully added cron job: {name}")
    except subprocess.CalledProcessError as e:
        print(f"Failed to add cron job: {name}. Error: {e}", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("Command 'docker' not found. Ensure it is installed and in PATH.", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    jobs_to_add = [
        ("market-intelligence-tuesday", "0 6 * * 2"),
        ("market-intelligence-thursday", "0 6 * * 4")
    ]
    remove_existing_jobs([job[0] for job in jobs_to_add])
    for name, cron_expr in jobs_to_add:
        run_cron_add(name, cron_expr)
