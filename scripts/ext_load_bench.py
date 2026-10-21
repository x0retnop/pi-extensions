#!/usr/bin/env python3
"""Read-only bench of live Pi extension load (jiti import + factory).

Uses the same loader as Pi. Does not start Pi, open a session, or write
~/.pi/agent/. Safe to run while a Pi session is open.

Usage (repo root):
    python scripts/ext_load_bench.py
    python scripts/ext_load_bench.py --json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MJS = Path(__file__).resolve().parent / "ext_load_bench.mjs"
OUT_DIR = ROOT / "_scratch"
OUT_TXT = OUT_DIR / "ext-load-bench.txt"
OUT_JSON = OUT_DIR / "ext-load-bench.json"


def run_node() -> dict:
    if not MJS.is_file():
        sys.exit(f"missing {MJS}")
    proc = subprocess.run(
        ["node", str(MJS)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or "")
        sys.stderr.write(proc.stdout or "")
        sys.exit(proc.returncode or 1)
    line = (proc.stdout or "").strip().splitlines()
    if not line:
        sys.stderr.write(proc.stderr or "node produced no JSON\n")
        sys.exit(1)
    try:
        return json.loads(line[-1])
    except json.JSONDecodeError as e:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr or "")
        sys.exit(f"bad JSON from node: {e}")


def fmt_table(data: dict) -> str:
    rows = sorted(data["rows"], key=lambda r: r["ms"], reverse=True)
    lines = [
        f"ext-load-bench  {data.get('at', datetime.now(timezone.utc).isoformat())}",
        f"source   {data['extDir']}",
        "safe     read-only loader; no Pi process; no session_start; no writes",
        "",
        f"{'ms':>6}  {'files':>5}  {'lines':>6}  {'ev':>3}  {'tools':>5}  {'cmds':>4}  name",
        f"{'-'*6}  {'-'*5}  {'-'*6}  {'-'*3}  {'-'*5}  {'-'*4}  {'-'*16}",
    ]
    for r in rows:
        mark = "  ERROR " + r["error"] if r.get("error") else ""
        lines.append(
            f"{r['ms']:6d}  {r['files']:5d}  {r['lines']:6d}  "
            f"{len(r['events']):3d}  {len(r['tools']):5d}  {len(r['cmds']):4d}  "
            f"{r['name']}{mark}"
        )
    lines.append(
        f"{'-'*6}  {'-'*5}  {'-'*6}  {'-'*3}  {'-'*5}  {'-'*4}  {'-'*16}"
    )
    lines.append(
        f"{data['wallMs']:6d}  {'':5}  {'':6}  {'':3}  {'':5}  {'':4}  "
        f"TOTAL  {data['count']} extensions, {data['errors']} errors"
    )
    lines.append("")
    lines.append("events / tools / cmds (load order = folder name A–Z, same as Pi):")
    for r in data["rows"]:
        ev = ",".join(r["events"]) if r["events"] else "-"
        tools = ",".join(r["tools"]) if r["tools"] else "-"
        cmds = ",".join(r["cmds"]) if r["cmds"] else "-"
        lines.append(f"  {r['name']}")
        lines.append(f"    events  {ev}")
        lines.append(f"    tools   {tools}")
        lines.append(f"    cmds    {cmds}")
    lines.append("")
    lines.append(
        "ms = jiti TypeScript compile + factory() for that folder. "
        "First row in load order also pays one-time jiti alias setup (~20ms)."
    )
    lines.append(
        "This is startup load only. session_start / per-turn cost is not measured "
        "(that would start a second Pi and write settings)."
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="print raw JSON only")
    args = parser.parse_args()

    data = run_node()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    if args.json:
        sys.stdout.write(json.dumps(data, indent=2) + "\n")
        return 0

    text = fmt_table(data)
    OUT_TXT.write_text(text, encoding="utf-8")
    sys.stdout.write(text)
    sys.stdout.write(f"\nwritten  {OUT_TXT}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
