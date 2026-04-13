#!/usr/bin/env python3
"""
DB sync helper for OpenClaw ad-hoc research sessions.
Delivers a pre-built JSON payload to the intel-report webhook.

Usage:
    python3 workspace/sync_db.py /tmp/intel-report-adhoc.json
"""
import os
import sys
import urllib.request

if len(sys.argv) < 2:
    print("FATAL ERROR: No JSON payload file provided.")
    sys.exit(1)

payload_file = sys.argv[1]

try:
    with open(payload_file, 'rb') as f:
        data = f.read()

    dns = os.environ.get('CRON_EVENT_PLANNER_DNS', '').rstrip('/')
    secret = os.environ.get('CRON_SECRET_KEY', '')

    if not dns or not secret:
        print("FATAL ERROR: CRON_EVENT_PLANNER_DNS or CRON_SECRET_KEY not set.")
        sys.exit(1)

    url = f"{dns}/api/webhooks/intel-report"
    req = urllib.request.Request(url, data=data, method='POST')
    req.add_header('Authorization', f"Bearer {secret}")
    req.add_header('Content-Type', 'application/json')

    with urllib.request.urlopen(req, timeout=30) as response:
        body = response.read().decode()
        print(f"SUCCESS: Database synced. HTTP {response.status}: {body}")

except Exception as e:
    print(f"FATAL ERROR: Database sync failed. {str(e)}")
    sys.exit(1)
