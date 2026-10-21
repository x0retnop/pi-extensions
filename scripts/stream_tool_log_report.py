#!/usr/bin/env python3
"""Summarize stream-tool-log for LLM agents.

Prefers INDEX.json + ev=diag (schema v2). Falls back to v1 stream_end/summary.

Usage:
  python scripts/stream_tool_log_report.py              # INDEX current / LATEST
  python scripts/stream_tool_log_report.py PATH.jsonl
  python scripts/stream_tool_log_report.py --recent 3
  python scripts/stream_tool_log_report.py --json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def log_dir() -> Path:
    return Path.home() / ".pi" / "agent" / "logs" / "stream-tool"


def load_index() -> dict | None:
    p = log_dir() / "INDEX.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def resolve_paths(args: argparse.Namespace) -> list[Path]:
    if args.paths:
        return [Path(p) for p in args.paths]
    d = log_dir()
    idx = load_index()
    if args.recent:
        if idx and idx.get("logs"):
            out: list[Path] = []
            seen: set[str] = set()
            for row in idx["logs"]:
                p = Path(str(row.get("log") or ""))
                key = str(p)
                if not p.is_file() or key in seen:
                    continue
                seen.add(key)
                out.append(p)
                if len(out) >= args.recent:
                    break
            if out:
                return out
        files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        return files[: args.recent]
    if idx and idx.get("current"):
        cur = Path(str(idx["current"]))
        if cur.is_file():
            return [cur]
    latest = d / "LATEST.txt"
    if latest.is_file():
        target = Path(latest.read_text(encoding="utf-8").strip().splitlines()[0])
        if target.is_file():
            return [target]
    files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[:1] if files else []


def load_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def v2_report(rows: list[dict]) -> dict | None:
    diags = [r for r in rows if r.get("ev") == "diag"]
    if not diags:
        return None
    counts: dict[str, int] = defaultdict(int)
    for d in diags:
        counts[str(d.get("verdict") or "none")] += 1
    return {
        "schema": 2,
        "diags": diags,
        "diag_count": len(diags),
        "verdicts": dict(counts),
    }


def flag_tool(t: dict) -> list[str]:
    flags: list[str] = []
    stream_ms = t.get("streamMs") or 0
    path_at = t.get("pathAtMs")
    content_at = t.get("contentAtMs")
    old_at = t.get("oldAtMs")
    arg_bytes = t.get("argBytes") or 0
    content_len = t.get("contentLen") or 0
    name = t.get("name")

    if stream_ms < 50 and arg_bytes > 1000:
        flags.append("large_args_tiny_stream_ms")
    if name == "write":
        if (
            path_at is not None
            and content_at is not None
            and content_at <= path_at + 5
            and content_len > 500
        ):
            flags.append("path+content_near_simultaneous")
        if path_at is None and (t.get("pathLen") or 0) > 0:
            flags.append("path_missing_milestone")
        if content_at is None and content_len > 0:
            flags.append("content_missing_milestone")
    if name in ("edit", "multi_edit", "insert") and stream_ms < 50 and arg_bytes > 800:
        flags.append("large_args_tiny_stream_ms")
    if path_at == 0 and (content_at == 0 or old_at == 0) and arg_bytes > 500:
        flags.append("all_milestones_at_0")
    return flags


def v1_analyze(rows: list[dict]) -> dict:
    streams: dict[int, dict] = {}
    summaries: list[str] = []
    exec_batches: list[dict] = []
    notes: list[str] = []
    milestones: dict[str, int] = defaultdict(int)

    for r in rows:
        ev = r.get("ev")
        if ev == "note":
            notes.append(str(r.get("text", "")))
        if ev == "summary" and r.get("line"):
            summaries.append(r["line"])
        if ev == "exec_batch":
            exec_batches.append(r)
        if ev == "tc_milestone":
            milestones[str(r.get("milestone"))] += 1
        if ev == "stream_end":
            sid = r.get("streamId")
            streams[sid] = r

    mut_streams = []
    for sid, s in sorted(streams.items(), key=lambda x: x[0] or 0):
        tools = s.get("tools") or []
        mut = [t for t in tools if t.get("name") in ("write", "edit", "multi_edit", "insert")]
        if not mut:
            continue
        annotated = [{**t, "flags": flag_tool(t)} for t in mut]
        mut_streams.append(
            {
                "streamId": sid,
                "provider": s.get("provider"),
                "model": s.get("model"),
                "api": s.get("api"),
                "streamMs": s.get("streamMs"),
                "preToolMs": s.get("preToolMs"),
                "toolArgsMs": s.get("toolArgsMs"),
                "outTok": s.get("outTok"),
                "toolCount": s.get("toolCount"),
                "mutCount": s.get("mutCount"),
                "tcEventCount": s.get("tcEventCount"),
                "mut": annotated,
            }
        )

    return {
        "schema": 1,
        "streams_total": len(streams),
        "mut_streams": mut_streams,
        "summaries": summaries,
        "exec_batches": [
            {
                "streamId": b.get("streamId"),
                "n": b.get("n"),
                "startSpreadMs": b.get("startSpreadMs"),
                "endSpreadMs": b.get("endSpreadMs"),
                "execWallMs": b.get("execWallMs"),
            }
            for b in exec_batches
        ],
        "milestone_counts": dict(milestones),
        "notes": notes,
        "insights": v1_insights(mut_streams, exec_batches),
    }


def v1_insights(mut_streams: list[dict], exec_batches: list[dict]) -> list[str]:
    out: list[str] = []
    if not mut_streams:
        out.append("No write/edit streams in this log.")
        return out

    buffered = 0
    progressive = 0
    for s in mut_streams:
        for t in s.get("mut") or []:
            flags = t.get("flags") or flag_tool(t)
            if flags:
                buffered += 1
            elif (t.get("contentAtMs") or t.get("oldAtMs") or 0) > 200:
                progressive += 1

    if buffered and not progressive:
        out.append(
            f"Likely provider/arg dump: {buffered} mut tool(s) flagged "
            f"(tiny streamMs and/or path+content together) — UI header late / pack pop."
        )
    elif progressive and not buffered:
        out.append(
            f"Args stream progressively ({progressive} tools with content/old lag >200ms). "
            f"If UI still looks empty → renderCall/scroll, not provider hold."
        )
    elif buffered and progressive:
        out.append(f"Mixed: flagged={buffered}, progressive={progressive}. Split by provider/model.")

    long_pre = [s for s in mut_streams if (s.get("preToolMs") or 0) > 3000]
    if long_pre:
        out.append(
            f"{len(long_pre)} stream(s) spent >3s before first toolcall "
            f"(thinking/text) — silence before any tool chrome."
        )

    for b in exec_batches:
        if (b.get("n") or 0) >= 2 and (b.get("endSpreadMs") or 0) < 50:
            out.append(
                f"exec_batch streamId={b.get('streamId')}: n={b.get('n')} "
                f"endSpreadMs={b.get('endSpreadMs')} — parallel execute finishes together."
            )
    return out


def print_v2(path: Path, report: dict) -> None:
    print(f"=== {path} ===")
    print(f"schema=2 diags={report['diag_count']} verdicts={report['verdicts']}")
    print("\n-- diag --")
    for d in report["diags"]:
        ui = ",".join(d.get("ui") or []) or "-"
        print(
            f"S{d.get('sid')} {d.get('provider')}/{d.get('model')} api={d.get('api')} "
            f"verdict={d.get('verdict')} silence={d.get('silenceMs')}ms "
            f"think={d.get('thinkChars')} text={d.get('textChars')} "
            f"stream={d.get('streamMs')}ms out={d.get('outTok')} ui={ui}"
        )
        for m in d.get("mut") or []:
            print(f"  {m.get('how')} path={m.get('path')}")


def print_v1(path: Path, report: dict) -> None:
    print(f"=== {path} ===")
    print(f"schema=1 streams_total={report['streams_total']} mut_streams={len(report['mut_streams'])}")
    print(f"milestones={report['milestone_counts']}")
    if report["notes"]:
        print("notes:")
        for n in report["notes"]:
            print(f"  - {n[:200]}")
    print("\n-- insights --")
    for i in report["insights"]:
        print(f"* {i}")
    print("\n-- summaries --")
    for line in report["summaries"]:
        print(line)
    print("\n-- mut streams --")
    for s in report["mut_streams"]:
        print(
            f"S{s['streamId']} {s.get('provider')}/{s.get('model')} api={s.get('api')} "
            f"streamMs={s.get('streamMs')} preToolMs={s.get('preToolMs')} "
            f"toolArgsMs={s.get('toolArgsMs')} outTok={s.get('outTok')} "
            f"tools={s.get('toolCount')} mut={s.get('mutCount')} tcEv={s.get('tcEventCount')}"
        )
        for t in s.get("mut") or []:
            print(
                f"  {str(t.get('name')):11} argBytes={t.get('argBytes')} "
                f"contentLen={t.get('contentLen')} streamMs={t.get('streamMs')} "
                f"path@={t.get('pathAtMs')} content@={t.get('contentAtMs')} "
                f"old@={t.get('oldAtMs')} new@={t.get('newAtMs')} deltas={t.get('deltas')} "
                f"path={t.get('pathShort')}"
            )
    if report["exec_batches"]:
        print("\n-- exec batches --")
        for b in report["exec_batches"]:
            print(
                f"  streamId={b.get('streamId')} n={b.get('n')} "
                f"startSpread={b.get('startSpreadMs')}ms endSpread={b.get('endSpreadMs')}ms "
                f"wall={b.get('execWallMs')}ms"
            )


def analyze_file(path: Path) -> dict:
    rows = load_rows(path)
    return v2_report(rows) or v1_analyze(rows)


def print_index_head() -> None:
    idx = load_index()
    if not idx:
        return
    print(
        f"INDEX enabled={idx.get('enabled')} current={idx.get('current')} "
        f"updated={idx.get('updatedAt')}"
    )
    last = None
    logs = idx.get("logs") or []
    if logs:
        last = logs[0].get("last")
        print(f"INDEX logs={len(logs)} last_file={logs[0].get('log')} verdicts={logs[0].get('verdicts')}")
    if last:
        print(
            f"INDEX last sid={last.get('sid')} verdict={last.get('verdict')} "
            f"{last.get('provider')}/{last.get('model')} silence={last.get('silenceMs')} "
            f"ui={last.get('ui')}"
        )
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("paths", nargs="*", help="JSONL log file(s)")
    ap.add_argument("--recent", type=int, default=0, help="N newest logs")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    paths = resolve_paths(args)
    if not paths:
        print("No stream-tool logs found under", log_dir(), file=sys.stderr)
        return 1

    all_reports = []
    if not args.json and not args.paths:
        print_index_head()

    for p in paths:
        if not p.is_file():
            print(f"missing: {p}", file=sys.stderr)
            continue
        rep = analyze_file(p)
        rep["path"] = str(p)
        all_reports.append(rep)
        if not args.json:
            if rep.get("schema") == 2:
                print_v2(p, rep)
            else:
                print_v1(p, rep)
            print()

    if not all_reports:
        return 1
    if args.json:
        payload = all_reports[0] if len(all_reports) == 1 else {"logs": all_reports}
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
