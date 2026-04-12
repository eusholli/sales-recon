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
MEMORY UPDATE & PRUNING PROTOCOL
All memory files use a simple append-only timestamp format.
1. Before researching, `read_file` the target's memory file. If the file does not exist, ignore the error and start fresh.
2. Append new research at the END of the file with `## [YYYY-MM-DD]` header.
3. Do NOT use `## Latest`, `## Profile`, or `## Archive` sections anymore.
4. AUTO-PRUNE: If the file exceeds 150 lines, autonomously summarize the oldest entries into a short paragraph and trim those raw lines so it does not waste context tokens.
5. Rate Limit & Search Cap: You MUST execute `web_search` calls SEQUENTIALLY, never in parallel. Wait 2 seconds between each search. The API allows only 1 request per second. NEVER perform more than 5 `web_search` calls total.
6. Error Reporting: If an error or rate limit happens, never fail silently. Output a bold FATAL error string in the final JSON or log.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. FETCH TARGETS
Use your terminal/shell tool (`exec`) to run this exact shell command:
curl --fail-with-body --show-error --max-time 30 -H "Authorization: Bearer {CRON_SECRET_KEY}" "{CRON_EVENT_PLANNER_DNS}/api/intelligence/targets"
If the curl step fails or returns invalid JSON (e.g. HTML error page), stop immediately and output a FATAL HTTP ERROR string explaining the failure. Do not proceed.
Filter for active targets (`subscriptionCount > 0`).

2. RESEARCH EACH ACTIVE TARGET
For each active company, attendee, or event:
a. `read_file` their memory file at `memory/{{Target_Name}}.md` (replace spaces with underscores).
b. If the file has been updated within the last 48 hours, skip research for this target.
c. If not fresh, run ONE `web_search` for recent 2026 news/agenda/announcements. (Observe the global 5 searches max per session limit).
d. Synthesize findings and WRITE to the memory file using the MEMORY UPDATE & PRUNING PROTOCOL.

3. BUILD PAYLOAD
You MUST generate the exact JSON format below for targets that had NEW intelligence.
salesAngle MUST map the target's current situation to a specific Rakuten Symphony capability (avoid generic benefits). Use `memory/Rakuten_Symphony.md` as reference if needed.
recommendedAction MUST BE a concrete sales-related next step.

{{
"runId": "YYYY-MM-DD-cron",
"timestamp": "<ISO 8601>",
"updatedTargets": [
    {{
    "type": "company" | "attendee" | "event",
    "name": "<exact name from targets>",
    "summary": "<2–3 sentence update>",
    "salesAngle": "<1 sentence referencing a specific RS initiative against target situation>",
    "recommendedAction": "<1-sentence time-sensitive next step, omit if no clear trigger>",
    "fullReport": "<The new timestamped findings you generated to append to memory>"
    }}
]
}}
If no new updates were found, return an empty `updatedTargets` array.

4. DELIVER
Use the write_file tool to write the JSON payload to /tmp/intel-report.json. Then use `exec` to run:
curl --fail-with-body --show-error --max-time 30 -X POST -H "Authorization: Bearer {CRON_SECRET_KEY}" -H "Content-Type: application/json" -d @/tmp/intel-report.json "{CRON_EVENT_PLANNER_DNS}/api/webhooks/intel-report"
If delivery fails, output a FATAL delivery error.

5. LOG
Append a brief one-line operational summary to `memory/YYYY-MM-DD.md`.
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
