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

CRON_MSG = """You are the trigger entry for the market-intelligence dispatcher.
Your only job is to invoke the external Python orchestrator via `exec` and
report its exit status. Do NOT do any research yourself — the dispatcher
spawns its own concurrent agent sessions for that.

Run this single shell command via the `exec` tool exactly as written —
no env-var prefix, no `$(...)` substitution, no quoting tricks. The
allowlist denies anything with shell metacharacters or env-var
assignment, so the command must be a plain `python3` invocation with
literal argv only:

```
python3 /app/intel-dispatcher.py
```

The dispatcher will compute today's run-id itself (`YYYY-MM-DD-cron`).
It does the research itself by spawning concurrent agent sessions. You
MUST NOT do any research, mkdir, cat, or file writes yourself — those
will be denied by the allowlist.

Each research agent MUST NOT exceed 15 web searches per session and MUST
space searches sequentially with a 300 ms delay between calls. Multiple
agents run in parallel across the dispatcher — this spacing keeps aggregate
API usage within the 50 req/sec Brave plan ceiling.

If the command exits 0, the run succeeded — report `OK runId=<value>`
(extract the runId from the dispatcher's stdout `dispatch start` log line).
If exit is non-zero, report `FATAL runId=<value> exit=<code>` and surface
the last 2 KB of stderr. Do not retry inside this turn; the dispatcher
persists intermediate state and the next scheduled run will resume.
"""


DREAM_CYCLE_MSG = """You are running the gbrain nightly dream cycle to keep the
sales intelligence brain healthy and self-maintaining.

Do NOT use the exec tool — gbrain credential-bearing execs are blocked by the
security allowlist regardless of path form. Use only gbrain MCP tools.

Step 1 — Submit the job:
  Call the gbrain MCP tool `submit_job` with:
    name: "autopilot-cycle"
    data: {}
  If submit_job returns an error, output FATAL: <error details> and stop.

Step 2 — Poll until complete:
  The job runs asynchronously. Poll using the gbrain MCP tool `get_job` with
  the ID returned by submit_job. Use `exec sleep 30` between each poll.
  Poll up to 20 times (10 minutes total). Terminal statuses are:
    completed, failed, dead, skipped

Step 3 — Report the final result:
  On completed or skipped: report OK job_id=<id> status=<status> and include
    the result.status and result.reason fields if present.
  On failed or dead: report FATAL job_id=<id> status=<status> and include
    the error details from the job result.
  If still not terminal after 20 polls: report TIMEOUT job_id=<id>.
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


def run_cron_add(name, cron_expr, message=CRON_MSG):
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
        message,
        "--session",
        "isolated",
        "--no-deliver",
        "--tz",
        "UTC",
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
        ("market-intelligence-tuesday", "0 1 * * 1", CRON_MSG),
        ("gbrain-dream-cycle-nightly", "0 3 * * *", DREAM_CYCLE_MSG),
    ]
    remove_existing_jobs([job[0] for job in jobs_to_add])
    for name, cron_expr, message in jobs_to_add:
        run_cron_add(name, cron_expr, message)
