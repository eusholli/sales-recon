#!/usr/bin/env python3
"""Phase-1 manual trigger for the Agentic Marketing Team.

Runs ONE OpenClaw agent session for ONE strategy theme and POSTs the resulting
campaign proposal to the event-planner. This is the thin vertical slice: it
proves the loop (strategy -> research/enrich -> proposal -> /campaigns UI) with
no fan-out, run-lock, or poison-pill. The full fan-out orchestrator
(marketing-dispatcher.py, mirroring intel-dispatcher.py) is Phase 3.

Flow:
  1. GET /api/marketing/strategy            -> pick a theme (by --theme or first)
  2. GET /api/marketing/content-inventory   -> existing reusable assets (reuse-first)
  3. Build the prompt from prompts/campaign-proposal.md
  4. Run one isolated OpenClaw agent session
  5. Parse the <CAMPAIGN_OUTPUT> JSON array from stdout
  6. POST { runId, proposals, discoveredCompanies } to /api/webhooks/campaign-proposal

Env required: CRON_EVENT_PLANNER_DNS, CRON_SECRET_KEY.
Env tunable:  OPENCLAW_BIN (/app/openclaw.mjs), MARKETING_AGENT_TIMEOUT_S (900),
              MARKETING_PROMPT_TEMPLATE, MARKETING_SCHEMA_PATH.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

VERSION = "1.0.0"

HERE = Path(__file__).resolve().parent
PROMPT_TEMPLATE_PATH = Path(os.environ.get("MARKETING_PROMPT_TEMPLATE", HERE / "prompts" / "campaign-proposal.md"))
SCHEMA_PATH = Path(os.environ.get("MARKETING_SCHEMA_PATH", HERE / "prompts" / "campaign-proposal.schema.json"))
OPENCLAW_BIN = os.environ.get("OPENCLAW_BIN", "/app/openclaw.mjs")

CRON_DNS = os.environ.get("CRON_EVENT_PLANNER_DNS", "").rstrip("/")
CRON_KEY = os.environ.get("CRON_SECRET_KEY", "")
AGENT_TIMEOUT_S = int(os.environ.get("MARKETING_AGENT_TIMEOUT_S", "900"))

CAMPAIGN_OUTPUT_RE = re.compile(r"<CAMPAIGN_OUTPUT>\s*(\[.*?\])\s*</CAMPAIGN_OUTPUT>", re.DOTALL)


def log(level: str, msg: str, **kwargs: Any) -> None:
    payload = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "level": level, "msg": msg, **kwargs}
    print(json.dumps(payload, default=str), flush=True)


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "unnamed"


def _get(url_path: str) -> dict[str, Any]:
    req = urllib.request.Request(f"{CRON_DNS}{url_path}", headers={"Authorization": f"Bearer {CRON_KEY}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def webhook_post(url_path: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                f"{CRON_DNS}{url_path}",
                data=body,
                method="POST",
                headers={"Authorization": f"Bearer {CRON_KEY}", "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last_err = exc
            backoff = 2 ** attempt
            log("warn", "webhook retry", attempt=attempt + 1, error=str(exc), backoffS=backoff)
            time.sleep(backoff)
    raise RuntimeError(f"webhook POST failed after 3 attempts: {last_err}")


def select_theme(themes: list[dict[str, Any]], wanted: str | None) -> dict[str, Any]:
    if not themes:
        raise RuntimeError("no themes in MarketingStrategy — seed one in the /campaigns/strategy editor first")
    if wanted:
        for t in themes:
            if str(t.get("name", "")).strip().lower() == wanted.strip().lower():
                return t
        raise RuntimeError(f"theme '{wanted}' not found in strategy")
    return themes[0]


def build_prompt(theme: dict[str, Any], inventory: dict[str, Any], run_id: str) -> str:
    template = PROMPT_TEMPLATE_PATH.read_text()
    schema_json = SCHEMA_PATH.read_text()
    allowed_types = inventory.get("allowedContentTypes") or []
    allowed_tags = inventory.get("allowedTags") or []
    return (
        template
        .replace("{{RUN_ID}}", run_id)
        .replace("{{TODAY}}", time.strftime("%Y-%m-%d", time.gmtime()))
        .replace("{{THEME_JSON}}", json.dumps(theme, indent=2))
        .replace("{{TARGET_COMPANIES_JSON}}", json.dumps(inventory.get("companies", []), indent=2))
        .replace("{{INVENTORY_JSON}}", json.dumps(inventory.get("assets", []), indent=2))
        .replace("{{ALLOWED_CONTENT_TYPES}}", ", ".join(allowed_types) if allowed_types else "(none configured)")
        .replace("{{ALLOWED_TAGS}}", ", ".join(allowed_tags) if allowed_tags else "(none configured)")
        .replace("{{SCHEMA_JSON}}", schema_json)
    )


def run_agent(prompt: str, run_id: str) -> str:
    # Unique session-id per invocation gives a fresh/isolated session (this OpenClaw
    # build has no `--session isolated` mode — only an explicit --session-id).
    session_id = f"marketing-{run_id}-{int(time.time())}"
    cmd = [
        "node", OPENCLAW_BIN, "agent",
        "--agent", "main",
        "--session-id", session_id,
        "--message", prompt,
        "--timeout", str(AGENT_TIMEOUT_S),
    ]
    log("info", "agent start", sessionId=session_id, timeoutS=AGENT_TIMEOUT_S)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=AGENT_TIMEOUT_S + 30)
    if proc.returncode != 0:
        raise RuntimeError(f"agent exit {proc.returncode}: {(proc.stderr or '')[-2000:]}")
    return proc.stdout or ""


def parse_proposal(stdout: str) -> dict[str, Any]:
    if "FATAL_RUN_ERROR" in stdout:
        tail = stdout[stdout.index("FATAL_RUN_ERROR"):][:300]
        raise RuntimeError(f"agent reported fatal error: {tail}")
    match = CAMPAIGN_OUTPUT_RE.search(stdout)
    if not match:
        raise RuntimeError(f"agent reply missing <CAMPAIGN_OUTPUT> markers; stdout tail: {stdout[-2000:]}")
    data = json.loads(match.group(1))
    if not isinstance(data, list) or not data:
        raise RuntimeError("agent output between markers is not a non-empty JSON array")
    proposal = data[0]
    if not isinstance(proposal, dict) or not proposal.get("theme") or not proposal.get("title"):
        raise RuntimeError("proposal missing required fields (theme, title)")
    return proposal


def main() -> int:
    parser = argparse.ArgumentParser(description="Agentic Marketing Team — single-theme trigger")
    parser.add_argument("--theme", default=None, help="Theme name to build a campaign for (default: first strategy theme)")
    parser.add_argument("--run-id", default=None, help="Run id (default: YYYY-MM-DD-marketing)")
    parser.add_argument("--no-webhook", action="store_true", help="Print the proposal instead of POSTing it")
    args = parser.parse_args()

    if not CRON_DNS or not CRON_KEY:
        log("fatal", "CRON_EVENT_PLANNER_DNS and CRON_SECRET_KEY must be set")
        return 1

    run_id = args.run_id or f"{time.strftime('%Y-%m-%d', time.gmtime())}-marketing"

    try:
        strategy = _get("/api/marketing/strategy")
        theme = select_theme(strategy.get("themes", []), args.theme)
        theme_name = str(theme.get("name", "")).strip()
        log("info", "theme selected", theme=theme_name, runId=run_id)

        inventory = _get(f"/api/marketing/content-inventory?theme={urllib.parse.quote(theme_name)}")
        log("info", "inventory fetched", assets=inventory.get("count", 0))

        prompt = build_prompt(theme, inventory, run_id)
        stdout = run_agent(prompt, run_id)
        proposal = parse_proposal(stdout)

        # Hoist discovered companies to the top-level payload for the webhook.
        discovered = proposal.get("discoveredCompanies") or []
        payload = {"runId": run_id, "proposals": [proposal], "discoveredCompanies": discovered}

        if args.no_webhook:
            print(json.dumps(payload, indent=2))
            log("info", "done (no-webhook)", theme=theme_name)
            return 0

        resp = webhook_post("/api/webhooks/campaign-proposal", payload)
        log("info", "proposal delivered", theme=theme_name, response=resp)
        return 0
    except subprocess.TimeoutExpired:
        log("fatal", "agent timed out", timeoutS=AGENT_TIMEOUT_S)
        return 2
    except Exception as exc:
        log("fatal", "marketing-once crashed", error=str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
