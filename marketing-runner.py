#!/usr/bin/env python3
"""On-demand campaign run poller.

Polls event-planner for PENDING CampaignRunRequest rows (enqueued by the browser
"Generate Campaign" button), claims one at a time, runs marketing-once.py for that
theme, and reports DONE/FAILED back. This is the bridge that lets the browser trigger
the agent without any reverse networking — it reuses the existing OpenClaw->event-planner
direction (CRON_SECRET_KEY) only.

Phase 3 reuses this exact runner: the cron just enqueues one request per strategy theme.

Env required: CRON_EVENT_PLANNER_DNS, CRON_SECRET_KEY.
Env tunable:  MARKETING_RUNNER_POLL_S (30), MARKETING_ONCE_PATH (/app/marketing-once.py),
              PYTHON_BIN (python3).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

CRON_DNS = os.environ.get("CRON_EVENT_PLANNER_DNS", "").rstrip("/")
CRON_KEY = os.environ.get("CRON_SECRET_KEY", "")
POLL_S = int(os.environ.get("MARKETING_RUNNER_POLL_S", "30"))
MARKETING_ONCE = os.environ.get("MARKETING_ONCE_PATH", "/app/marketing-once.py")
PYTHON_BIN = os.environ.get("PYTHON_BIN", "python3")

# marketing-once.py logs one JSON line per event; the delivery line carries the proposal id.
DELIVERED_RE = re.compile(r'"msg":\s*"proposal delivered".*?"id":\s*"([^"]+)"', re.DOTALL)


def log(level: str, msg: str, **kwargs: Any) -> None:
    print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "level": level, "msg": msg, **kwargs}, default=str), flush=True)


def _req(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {CRON_KEY}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{CRON_DNS}{path}", data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def claim_next() -> dict[str, Any] | None:
    try:
        pending = _req("GET", "/api/marketing/run-requests?status=PENDING").get("requests", [])
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log("warn", "poll failed", error=str(exc))
        return None
    for r in pending:
        rid = r.get("id")
        if not rid:
            continue
        try:
            # Claim: flip to RUNNING and stamp the runId we will use for the proposal.
            _req("PATCH", f"/api/marketing/run-requests/{rid}", {"status": "RUNNING", "runId": rid})
            return r
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            log("warn", "claim failed", id=rid, error=str(exc))
    return None


def run_request(request: dict[str, Any]) -> None:
    rid = request["id"]
    theme = request.get("theme", "")
    log("info", "running request", id=rid, theme=theme)
    try:
        proc = subprocess.run(
            [PYTHON_BIN, MARKETING_ONCE, "--theme", theme, "--run-id", rid],
            capture_output=True, text=True, timeout=1200,
        )
        stdout = proc.stdout or ""
        if proc.returncode != 0:
            err = (proc.stderr or stdout or "")[-1500:]
            _req("PATCH", f"/api/marketing/run-requests/{rid}", {"status": "FAILED", "error": err})
            log("error", "request failed", id=rid, code=proc.returncode)
            return
        m = DELIVERED_RE.search(stdout)
        patch: dict[str, Any] = {"status": "DONE"}
        if m:
            patch["proposalId"] = m.group(1)
        _req("PATCH", f"/api/marketing/run-requests/{rid}", patch)
        log("info", "request done", id=rid, proposalId=patch.get("proposalId"))
    except subprocess.TimeoutExpired:
        _req("PATCH", f"/api/marketing/run-requests/{rid}", {"status": "FAILED", "error": "agent timed out"})
        log("error", "request timed out", id=rid)
    except Exception as exc:  # noqa: BLE001 — report any failure back to the queue
        try:
            _req("PATCH", f"/api/marketing/run-requests/{rid}", {"status": "FAILED", "error": str(exc)[:1500]})
        except Exception:  # noqa: BLE001
            pass
        log("error", "request crashed", id=rid, error=str(exc))


def main() -> int:
    if not CRON_DNS or not CRON_KEY:
        log("fatal", "CRON_EVENT_PLANNER_DNS and CRON_SECRET_KEY must be set")
        return 1
    log("info", "marketing-runner started", pollSeconds=POLL_S, dns=CRON_DNS)
    while True:
        request = claim_next()
        if request:
            run_request(request)
            continue  # immediately check for more before sleeping
        time.sleep(POLL_S)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
