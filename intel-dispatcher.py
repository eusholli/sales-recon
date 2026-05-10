#!/usr/bin/env python3
"""Intelligence-report dispatcher for sales-recon.

Replaces the single-agent serial loop in event-planner-cron.py's CRON_MSG with
a fan-out orchestrator that:

  1. Fetches the active subscription target list from the event-planner.
  2. Chunks targets into mini-batches (5 by default).
  3. Spawns isolated OpenClaw agent sessions concurrently (bounded semaphore).
  4. Each batch writes its JSON output to a per-batch file on disk via the
     agent's `exec` tool — atomic via temp-file + rename.
  5. After every batch, POSTs that batch to the webhook with silent=true so
     intermediate state is durable in the event-planner DB.
  6. After all batches, triggers chunked digest delivery (silent=false) by
     calling the webhook in subscriber slices to avoid the 300s function
     timeout.

Failure isolation: a single batch failure never halts the run. Failed batches
are written as <batchIdx>.error.json. Cross-run poison-pill counters live in
poison.json under the runs/ root and skip targets that fail 3 runs in a row.

Resume: the run-lock contains the running PID; on startup any stale lock
(PID not alive) is cleared and existing <batchIdx>.json outputs are reused
because webhook upserts are idempotent on (runId, targetName).

Env required: CRON_EVENT_PLANNER_DNS, CRON_SECRET_KEY.
Env tunable: INTEL_BATCH_SIZE (5), INTEL_DISPATCH_CONCURRENCY (4),
             INTEL_NOTIFY_CHUNK (20), LLM_RPM (120), LLM_TPM (0=off).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import signal
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DISPATCHER_VERSION = "1.0.0"

# OpenClaw container conventions: workspace volume is /home/node/.openclaw and
# is persisted across container restarts via the OPENCLAW_WORKSPACE_DIR mount.
WORKSPACE_ROOT = Path(os.environ.get("INTEL_WORKSPACE_ROOT", "/home/node/.openclaw/workspace"))
RUNS_ROOT = WORKSPACE_ROOT / "intel-jobs"
PROMPT_TEMPLATE_PATH = Path(os.environ.get("INTEL_PROMPT_TEMPLATE", "/app/prompts/intel-batch.md"))
SCHEMA_PATH = Path(os.environ.get("INTEL_SCHEMA_PATH", "/app/prompts/target-update.schema.json"))

CRON_DNS = os.environ.get("CRON_EVENT_PLANNER_DNS", "").rstrip("/")
CRON_KEY = os.environ.get("CRON_SECRET_KEY", "")
BATCH_SIZE = int(os.environ.get("INTEL_BATCH_SIZE", "5"))
CONCURRENCY = int(os.environ.get("INTEL_DISPATCH_CONCURRENCY", "4"))
NOTIFY_CHUNK = int(os.environ.get("INTEL_NOTIFY_CHUNK", "20"))
LLM_RPM = int(os.environ.get("LLM_RPM", "120"))
AGENT_TIMEOUT_S = int(os.environ.get("INTEL_AGENT_TIMEOUT_S", "900"))
WEBHOOK_TIMEOUT_S = int(os.environ.get("INTEL_WEBHOOK_TIMEOUT_S", "120"))
POISON_THRESHOLD = int(os.environ.get("INTEL_POISON_THRESHOLD", "3"))


def log(level: str, msg: str, **kwargs: Any) -> None:
    payload = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "level": level, "msg": msg, **kwargs}
    print(json.dumps(payload, default=str), flush=True)


# --- atomic file helpers --------------------------------------------------

def atomic_write(path: Path, body: str) -> None:
    """Write body to path atomically via temp-file + rename. Same FS only."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}.{random.randint(0, 1 << 30)}")
    tmp.write_text(body)
    os.replace(tmp, path)


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "unnamed"


# --- run lock + resume ----------------------------------------------------

def acquire_run_lock(run_dir: Path) -> None:
    """Acquire a PID-based run lock. Steal stale locks whose PID is dead."""
    run_dir.mkdir(parents=True, exist_ok=True)
    lock_path = run_dir / ".lock"
    if lock_path.exists():
        try:
            existing = json.loads(lock_path.read_text())
            pid = int(existing.get("pid", 0))
            alive = pid > 0 and _pid_alive(pid)
            if alive:
                raise RuntimeError(f"run already in progress (pid={pid}, started={existing.get('startedAt')})")
            log("warn", "stealing stale run lock", stalePid=pid, lockPath=str(lock_path))
        except (json.JSONDecodeError, ValueError):
            log("warn", "corrupt run lock, replacing", lockPath=str(lock_path))
    atomic_write(lock_path, json.dumps({"pid": os.getpid(), "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "version": DISPATCHER_VERSION}))


def release_run_lock(run_dir: Path) -> None:
    try:
        (run_dir / ".lock").unlink(missing_ok=True)
    except Exception as exc:
        log("warn", "failed to release run lock", error=str(exc))


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


# --- poison-pill tracking -------------------------------------------------

POISON_PATH = RUNS_ROOT / "poison.json"


def load_poison() -> dict[str, int]:
    if not POISON_PATH.exists():
        return {}
    try:
        return json.loads(POISON_PATH.read_text())
    except json.JSONDecodeError:
        log("warn", "corrupt poison.json, resetting")
        return {}


def save_poison(p: dict[str, int]) -> None:
    atomic_write(POISON_PATH, json.dumps(p, indent=2, sort_keys=True))


def is_poisoned(p: dict[str, int], slug: str) -> bool:
    return p.get(slug, 0) >= POISON_THRESHOLD


# --- target fetch + chunking ---------------------------------------------

@dataclass
class Target:
    type: str  # company | attendee | event
    name: str
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def slug(self) -> str:
        return f"{self.type}/{slugify(self.name)}"


def fetch_targets() -> list[Target]:
    if not CRON_DNS or not CRON_KEY:
        raise RuntimeError("CRON_EVENT_PLANNER_DNS and CRON_SECRET_KEY must be set")
    req = urllib.request.Request(
        f"{CRON_DNS}/api/intelligence/targets",
        headers={"Authorization": f"Bearer {CRON_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    targets: list[Target] = []
    for c in body.get("companies", []):
        if c.get("subscriptionCount", 0) > 0:
            targets.append(Target("company", c["name"], {"pipelineValue": c.get("pipelineValue")}))
    for a in body.get("attendees", []):
        if a.get("subscriptionCount", 0) > 0:
            targets.append(Target("attendee", a["name"], {"title": a.get("title"), "company": a.get("company")}))
    for e in body.get("events", []):
        if e.get("subscriptionCount", 0) > 0:
            targets.append(Target("event", e["name"], {"startDate": e.get("startDate"), "linkedAttendees": e.get("linkedAttendees", [])}))
    return targets


def chunk(seq: list[Target], n: int) -> list[list[Target]]:
    return [seq[i:i + n] for i in range(0, len(seq), n)]


# --- agent invocation -----------------------------------------------------

def build_batch_prompt(template: str, schema_json: str, batch_idx: int, output_path: str, targets: list[Target]) -> str:
    target_descriptors = [{"type": t.type, "name": t.name, **t.extra} for t in targets]
    return (
        template
        .replace("{{SCHEMA_JSON}}", schema_json)
        .replace("{{BATCH_INDEX}}", str(batch_idx))
        .replace("{{OUTPUT_PATH}}", output_path)
        .replace("{{TARGETS_JSON}}", json.dumps(target_descriptors, indent=2))
    )


async def run_agent_batch(batch_idx: int, targets: list[Target], run_id: str, run_dir: Path,
                          rate_limiter: "TokenBucket", schema_json: str, prompt_template: str) -> tuple[int, list[dict[str, Any]] | None, str | None]:
    """Run one OpenClaw agent session for a batch. Returns (batch_idx, targets_json|None, error|None)."""
    output_path = str(run_dir / f"batch-{batch_idx:04d}.agent.json")
    prompt = build_batch_prompt(prompt_template, schema_json, batch_idx, output_path, targets)

    # Resume: if output already present and parses, skip the agent call.
    output_file = Path(output_path)
    if output_file.exists():
        try:
            data = json.loads(output_file.read_text())
            if isinstance(data, list):
                log("info", "batch resumed from existing output", batchIdx=batch_idx, targets=len(data))
                return (batch_idx, data, None)
        except json.JSONDecodeError:
            log("warn", "stale batch output, rerunning", batchIdx=batch_idx)

    await rate_limiter.acquire()

    session_id = f"intel-{run_id}-b{batch_idx:04d}"
    cmd = [
        "node", "/app/openclaw.mjs", "agent",
        "--agent", "main",
        "--session-id", session_id,
        "--message", prompt,
        "--json",
        "--timeout", str(AGENT_TIMEOUT_S),
    ]

    started = time.monotonic()
    log("info", "agent batch start", batchIdx=batch_idx, sessionId=session_id, targets=len(targets))
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=AGENT_TIMEOUT_S + 30)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"agent batch timed out after {AGENT_TIMEOUT_S}s")
        elapsed = time.monotonic() - started
        if proc.returncode != 0:
            err_tail = (stderr_b.decode("utf-8", errors="replace") or "")[-2000:]
            raise RuntimeError(f"agent exit {proc.returncode}: {err_tail}")

        if not output_file.exists():
            stdout_tail = (stdout_b.decode("utf-8", errors="replace") or "")[-2000:]
            raise RuntimeError(f"agent did not write expected output {output_path}; stdout tail: {stdout_tail}")
        try:
            data = json.loads(output_file.read_text())
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"agent wrote unparseable JSON at {output_path}: {exc}")
        if not isinstance(data, list):
            raise RuntimeError(f"agent output at {output_path} is not a JSON array")

        log("info", "agent batch ok", batchIdx=batch_idx, targets=len(data), elapsedS=round(elapsed, 1))
        return (batch_idx, data, None)
    except Exception as exc:
        elapsed = time.monotonic() - started
        log("error", "agent batch failed", batchIdx=batch_idx, error=str(exc), elapsedS=round(elapsed, 1))
        return (batch_idx, None, str(exc))


# --- token bucket ---------------------------------------------------------

class TokenBucket:
    """Simple async token bucket capping requests per minute."""

    def __init__(self, rpm: int) -> None:
        self.rpm = max(rpm, 1)
        self._lock = asyncio.Lock()
        self._tokens = float(self.rpm)
        self._last = time.monotonic()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last
            self._last = now
            self._tokens = min(self.rpm, self._tokens + elapsed * (self.rpm / 60.0))
            if self._tokens < 1:
                wait = (1 - self._tokens) / (self.rpm / 60.0)
                await asyncio.sleep(wait)
                self._tokens = 0
            else:
                self._tokens -= 1


# --- webhook delivery -----------------------------------------------------

async def webhook_post(url_path: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    full_url = f"{CRON_DNS}{url_path}"

    def _do_post() -> dict[str, Any]:
        req = urllib.request.Request(
            full_url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {CRON_KEY}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=WEBHOOK_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8"))

    last_err: Exception | None = None
    for attempt in range(3):
        try:
            return await asyncio.to_thread(_do_post)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last_err = exc
            backoff = 2 ** attempt + random.random()
            log("warn", "webhook retry", url=full_url, attempt=attempt + 1, error=str(exc), backoffS=round(backoff, 1))
            await asyncio.sleep(backoff)
    raise RuntimeError(f"webhook POST failed after 3 attempts: {last_err}")


# --- main orchestration ---------------------------------------------------

@dataclass
class BatchResult:
    batch_idx: int
    targets: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None


async def run(run_id: str, limit: int | None, no_webhook: bool, silent_only: bool) -> int:
    run_dir = RUNS_ROOT / run_id
    acquire_run_lock(run_dir)
    summary_path = run_dir / "SUMMARY.json"
    schema_json = SCHEMA_PATH.read_text()
    prompt_template = PROMPT_TEMPLATE_PATH.read_text()

    started_at = time.monotonic()
    poison = load_poison()
    targets = fetch_targets()
    if limit is not None:
        targets = targets[:limit]

    # Filter poisoned targets before chunking.
    skipped_poison: list[str] = []
    keep: list[Target] = []
    for t in targets:
        if is_poisoned(poison, t.slug):
            skipped_poison.append(t.slug)
            log("warn", "skipping poisoned target", slug=t.slug, attempts=poison.get(t.slug, 0))
        else:
            keep.append(t)
    targets = keep
    batches = chunk(targets, BATCH_SIZE)
    log("info", "dispatch start", runId=run_id, totalTargets=len(targets), batches=len(batches),
        concurrency=CONCURRENCY, batchSize=BATCH_SIZE, skippedPoison=len(skipped_poison))

    semaphore = asyncio.Semaphore(CONCURRENCY)
    rate_limiter = TokenBucket(LLM_RPM)
    results: list[BatchResult] = []

    async def run_one(idx: int, batch: list[Target]) -> BatchResult:
        async with semaphore:
            batch_idx, data, err = await run_agent_batch(idx, batch, run_id, run_dir, rate_limiter, schema_json, prompt_template)
            if err is not None:
                atomic_write(run_dir / f"batch-{idx:04d}.error.json",
                             json.dumps({"batchIdx": idx, "targets": [t.name for t in batch], "error": err}, indent=2))
                # Increment poison counters for the targets in this failed batch.
                for t in batch:
                    poison[t.slug] = poison.get(t.slug, 0) + 1
                save_poison(poison)
                return BatchResult(batch_idx=idx, error=err)

            assert data is not None
            atomic_write(run_dir / f"batch-{idx:04d}.json", json.dumps(data, indent=2))
            # Reset poison on success.
            for t in batch:
                if t.slug in poison:
                    poison.pop(t.slug, None)
            save_poison(poison)

            if not no_webhook:
                try:
                    await webhook_post("/api/webhooks/intel-report",
                                       {"runId": run_id, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                        "updatedTargets": data, "silent": True})
                except Exception as exc:
                    log("error", "silent webhook batch POST failed", batchIdx=idx, error=str(exc))
                    # Non-fatal: file is on disk and can be replayed.
            return BatchResult(batch_idx=idx, targets=data)

    results = await asyncio.gather(*(run_one(i, b) for i, b in enumerate(batches)))

    succeeded = [r for r in results if r.error is None]
    failed = [r for r in results if r.error is not None]
    all_targets: list[dict[str, Any]] = []
    for r in succeeded:
        all_targets.extend(r.targets)

    # Final notify: chunked digest delivery.
    notify_status = "skipped"
    if not no_webhook and not silent_only and all_targets:
        try:
            # First call: do upserts + aggregate-email gating + slice 0..NOTIFY_CHUNK.
            offset = 0
            while True:
                resp = await webhook_post(
                    f"/api/webhooks/intel-report?subscriberOffset={offset}&subscriberLimit={NOTIFY_CHUNK}",
                    {"runId": run_id, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                     "updatedTargets": all_targets, "silent": False},
                )
                next_offset = int(resp.get("nextOffset", -1))
                total = int(resp.get("total", 0))
                log("info", "notify slice ok", offset=offset, nextOffset=next_offset, total=total, sent=resp.get("emailsSent"))
                if next_offset < 0 or next_offset >= total:
                    break
                offset = next_offset
            notify_status = "ok"
        except Exception as exc:
            log("error", "notify failed", error=str(exc))
            notify_status = f"failed: {exc}"

    elapsed = time.monotonic() - started_at
    summary = {
        "runId": run_id,
        "version": DISPATCHER_VERSION,
        "elapsedS": round(elapsed, 1),
        "totalTargets": len(targets) + len(skipped_poison),
        "batchSize": BATCH_SIZE,
        "concurrency": CONCURRENCY,
        "batches": len(batches),
        "succeededBatches": len(succeeded),
        "failedBatches": len(failed),
        "succeededTargets": len(all_targets),
        "skippedPoison": skipped_poison,
        "notifyStatus": notify_status,
        "errors": [{"batchIdx": r.batch_idx, "error": r.error} for r in failed],
    }
    atomic_write(summary_path, json.dumps(summary, indent=2))
    log("info", "dispatch done", **{k: v for k, v in summary.items() if k != "errors"})

    release_run_lock(run_dir)
    return 0 if not failed else 2


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sales-recon intelligence dispatcher")
    p.add_argument("--run-id", required=True, help="Run identifier, e.g. 2026-05-12-cron")
    p.add_argument("--limit", type=int, default=None, help="Cap number of targets (smoke testing)")
    p.add_argument("--no-webhook", action="store_true", help="Skip all webhook POSTs")
    p.add_argument("--silent-only", action="store_true", help="POST per-batch silent only; skip final notify")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    def _on_term(signum: int, _frame: Any) -> None:
        log("warn", "received signal, exiting after current tasks", signum=signum)
        # asyncio loop exit: best-effort, lock will be considered stale on resume.
        sys.exit(130)

    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)

    try:
        return asyncio.run(run(args.run_id, args.limit, args.no_webhook, args.silent_only))
    except Exception as exc:
        log("fatal", "dispatcher crashed", error=str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
