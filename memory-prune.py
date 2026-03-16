#!/usr/bin/env python3
"""
memory-prune.py — Archive section pruner for OpenClaw memory files.

Keeps the top 50 lines of each ## Archive section, removing older entries
that compound token consumption during intelligence cron runs.

Usage:
    python3 memory-prune.py [--dry-run] [--memory-dir PATH]
"""

import argparse
import os
import re
import sys
from datetime import date
from pathlib import Path

# Load environment variables from .env file if it exists
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#"):
                _parts = _line.split("=", 1)
                if len(_parts) == 2:
                    _key, _val = _parts
                    os.environ[_key.strip()] = _val.strip().strip("\"'")

_workspace = os.environ.get("OPENCLAW_WORKSPACE_DIR", "/Users/eusholli/.openclaw/workspace")
DEFAULT_MEMORY_DIR = Path(_workspace) / "memory"
ARCHIVE_LIMIT = 50
DAILY_LOG_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}")


def parse_sections(text):
    """
    Split file text into ordered list of (header, body) tuples.
    The first element may have an empty header (content before the first ## heading).
    Returns list of (header_line, body_lines) where header_line is '' for preamble.
    """
    lines = text.splitlines(keepends=True)
    sections = []
    current_header = ""
    current_body = []

    for line in lines:
        if line.startswith("## "):
            sections.append((current_header, current_body))
            current_header = line
            current_body = []
        else:
            current_body.append(line)

    sections.append((current_header, current_body))
    return sections


def reconstruct(sections):
    """Reconstruct file text from parsed sections."""
    parts = []
    for header, body in sections:
        parts.append(header)
        parts.extend(body)
    return "".join(parts)


def is_content_line(line):
    """True for non-empty lines that are not HTML comments (e.g. pruned markers)."""
    s = line.strip()
    return bool(s) and not s.startswith("<!--")


def prune_file(path, dry_run, today_str):
    """
    Prune the ## Archive section of a single memory file.

    Returns one of: 'pruned', 'skipped', 'no_archive', 'error'
    """
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as e:
        print(f"  ERROR reading {path.name}: {e}", file=sys.stderr)
        return "error"

    sections = parse_sections(text)

    # Find the Archive section index
    archive_idx = None
    for i, (header, _) in enumerate(sections):
        if header.rstrip() == "## Archive":
            archive_idx = i
            break

    if archive_idx is None:
        return "no_archive"

    archive_header, archive_body = sections[archive_idx]
    content_lines = [line for line in archive_body if is_content_line(line)]

    if len(content_lines) <= ARCHIVE_LIMIT:
        return "skipped"

    # Keep top 50 content lines, preserving their original form.
    # We walk archive_body and collect lines until we have 50 content lines.
    kept_body = []
    kept_count = 0
    for line in archive_body:
        if kept_count >= ARCHIVE_LIMIT:
            break
        kept_body.append(line)
        if is_content_line(line):
            kept_count += 1

    removed = len(content_lines) - ARCHIVE_LIMIT
    marker = f"<!-- pruned: {removed} lines removed on {today_str} -->\n"
    kept_body.append(marker)

    if dry_run:
        print(
            f"  {path.name}: would remove {removed} archive lines"
            f" (keeping top {ARCHIVE_LIMIT} of {len(content_lines)})"
        )
        return "pruned"

    sections[archive_idx] = (archive_header, kept_body)
    new_text = reconstruct(sections)

    try:
        path.write_text(new_text, encoding="utf-8")
    except Exception as e:
        print(f"  ERROR writing {path.name}: {e}", file=sys.stderr)
        return "error"

    print(
        f"  {path.name}: removed {removed} archive lines"
        f" (kept top {ARCHIVE_LIMIT} of {len(content_lines)})"
    )
    return "pruned"


def main():
    parser = argparse.ArgumentParser(description="Prune ## Archive sections in OpenClaw memory files.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without writing any files.",
    )
    parser.add_argument(
        "--memory-dir",
        type=Path,
        default=DEFAULT_MEMORY_DIR,
        help=f"Path to memory directory (default: {DEFAULT_MEMORY_DIR})",
    )
    args = parser.parse_args()

    memory_dir = args.memory_dir
    if not memory_dir.is_dir():
        print(f"ERROR: memory directory not found: {memory_dir}", file=sys.stderr)
        sys.exit(1)

    today_str = date.today().isoformat()
    md_files = sorted(memory_dir.glob("*.md"))

    counts = {"pruned": 0, "skipped": 0, "no_archive": 0, "error": 0}
    total = len(md_files)

    if args.dry_run:
        print(f"[DRY RUN] Scanning {total} .md files in {memory_dir}\n")
    else:
        print(f"Scanning {total} .md files in {memory_dir}\n")

    for path in md_files:
        # Skip daily log files (YYYY-MM-DD*.md)
        if DAILY_LOG_PATTERN.match(path.stem):
            continue

        result = prune_file(path, args.dry_run, today_str)
        counts[result] += 1

    scanned = sum(counts.values())
    print(
        f"\nDone. {scanned} profile files processed: "
        f"{counts['pruned']} pruned, "
        f"{counts['skipped']} skipped (≤{ARCHIVE_LIMIT} lines), "
        f"{counts['no_archive']} no-archive, "
        f"{counts['error']} errors."
    )

    if counts["error"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
