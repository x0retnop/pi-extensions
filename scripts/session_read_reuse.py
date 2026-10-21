#!/usr/bin/env python3
"""Estimate supersedable full-file `read` results across Pi sessions.

Answers: how often does the agent full-read the same path more than once, and
how many result-bytes would a "keep only the last full read per path" policy
free — optionally only when an edit of that path sits between the reads.

Designed for consumption by an agent (JSON) or a human (text). Can run standalone
or via ``pi_session_inspect.py --read-reuse``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path

# Reuse session discovery from the main inspector when available.
try:
    from pi_session_inspect import extract_project, iter_sessions, get_sessions_dir
except ImportError:  # running as scripts/session_read_reuse.py
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from pi_session_inspect import extract_project, iter_sessions, get_sessions_dir  # type: ignore


WRITE_TOOLS = frozenset({"edit", "multi_edit", "insert", "write"})
DEFAULT_MIN_CHARS = 2000  # below this, stubbing is noise


def _norm_path(raw: str | None) -> str | None:
    if not raw or not isinstance(raw, str):
        return None
    p = raw.strip().strip("\"'")
    if not p:
        return None
    # Git Bash /c/... → C:/...
    p = re.sub(r"^/([a-zA-Z])(?=/)", lambda m: m.group(1).upper() + ":", p)
    p = p.replace("\\", "/")
    # Collapse duplicate slashes except after scheme/drive
    if re.match(r"^[A-Za-z]:/", p):
        drive, rest = p[:2], p[2:]
        rest = re.sub(r"/+", "/", rest)
        p = drive + rest
    else:
        p = re.sub(r"/+", "/", p)
    return p.lower()


def _result_text_len(message: dict) -> int:
    parts = []
    for item in message.get("content") or []:
        if isinstance(item, dict) and item.get("type", "text") in (None, "text"):
            parts.append(item.get("text") or "")
        elif isinstance(item, dict) and "text" in item:
            parts.append(item.get("text") or "")
    return sum(len(x) for x in parts)


def _is_full_read(args: dict) -> bool:
    """True when the read is a whole-file (or whole default) dump, not a window."""
    if not isinstance(args, dict):
        return False
    mode = (args.get("mode") or "raw").lower()
    if mode in ("overview", "section", "grep", "headtail"):
        return False
    if args.get("target"):
        return False
    # offset/limit (even offset=0) is a window, not a supersede-able full dump
    if args.get("offset") is not None or args.get("limit") is not None:
        return False
    return True


def _tool_path(args: dict | None) -> str | None:
    if not isinstance(args, dict):
        return None
    return _norm_path(args.get("path") or args.get("file_path") or args.get("file"))


@dataclass
class ReadHit:
    call_id: str
    path: str
    is_full: bool
    result_chars: int
    is_error: bool
    order: int  # sequence in session
    mode: str


@dataclass
class PathReuse:
    path: str
    full_reads: int
    stub_candidates: int  # full reads that are not the last one
    stub_chars: int  # chars in those candidates (if >= min)
    had_write_between: bool
    last_full_chars: int


@dataclass
class SessionReuse:
    session: str
    project: str
    total_reads: int
    full_reads: int
    partial_reads: int
    total_read_result_chars: int
    total_tool_result_chars: int
    paths_with_reuse: int
    stub_chars: int
    stub_chars_after_write: int  # subset: re-read after edit (strongest case)
    stub_chars_pure_reread: int  # same path re-read without edit between
    stub_count: int
    top_paths: list[dict] = field(default_factory=list)


def analyze_session_messages(messages: list[dict], min_chars: int = DEFAULT_MIN_CHARS) -> dict:
    """Core analysis on an already-loaded session message list."""
    # call_id -> meta from assistant toolCall
    calls: dict[str, dict] = {}
    # ordered stream of (kind, ...)
    order = 0
    write_orders: dict[str, list[int]] = defaultdict(list)  # path -> orders of writes
    read_hits: list[ReadHit] = []
    total_tool_result_chars = 0
    total_reads = 0

    for msg in messages:
        if msg.get("type") != "message":
            continue
        m = msg.get("message") or {}
        role = m.get("role")

        if role == "assistant":
            for c in m.get("content") or []:
                if not isinstance(c, dict) or c.get("type") != "toolCall":
                    continue
                name = c.get("name") or ""
                cid = c.get("id") or ""
                args = c.get("arguments") or {}
                path = _tool_path(args)
                if name == "read" and cid:
                    calls[cid] = {
                        "path": path,
                        "is_full": _is_full_read(args),
                        "mode": (args.get("mode") or "raw"),
                        "order": order,
                    }
                    order += 1
                    total_reads += 1
                elif name in WRITE_TOOLS and path:
                    write_orders[path].append(order)
                    order += 1
                else:
                    order += 1

        elif role == "toolResult":
            n = _result_text_len(m)
            total_tool_result_chars += n
            tool = m.get("toolName") or ""
            cid = m.get("toolCallId") or ""
            if tool != "read":
                continue
            meta = calls.get(cid) or {}
            path = meta.get("path")
            if not path:
                # fallback: cannot attribute — skip reuse accounting
                continue
            hit = ReadHit(
                call_id=cid,
                path=path,
                is_full=bool(meta.get("is_full")),
                result_chars=n,
                is_error=bool(m.get("isError")),
                order=meta.get("order", order),
                mode=str(meta.get("mode") or "raw"),
            )
            read_hits.append(hit)

    full_ok = [h for h in read_hits if h.is_full and not h.is_error]
    partial = [h for h in read_hits if not h.is_full]
    total_read_result_chars = sum(h.result_chars for h in read_hits)

    by_path: dict[str, list[ReadHit]] = defaultdict(list)
    for h in full_ok:
        by_path[h.path].append(h)

    path_stats: list[PathReuse] = []
    stub_chars = 0
    stub_chars_after_write = 0
    stub_chars_pure = 0
    stub_count = 0

    for path, hits in by_path.items():
        hits.sort(key=lambda h: h.order)
        if len(hits) < 2:
            continue
        # All but last are candidates
        candidates = hits[:-1]
        last = hits[-1]
        # Only count candidates above min size
        eligible = [h for h in candidates if h.result_chars >= min_chars]
        if not eligible:
            # still record path reuse for diagnostics
            path_stats.append(
                PathReuse(
                    path=path,
                    full_reads=len(hits),
                    stub_candidates=0,
                    stub_chars=0,
                    had_write_between=False,
                    last_full_chars=last.result_chars,
                )
            )
            continue

        # write between earliest eligible and last full read?
        w_orders = write_orders.get(path) or []
        first_o = eligible[0].order
        last_o = last.order
        had_write = any(first_o < w < last_o for w in w_orders)

        sc = sum(h.result_chars for h in eligible)
        stub_chars += sc
        stub_count += len(eligible)
        if had_write:
            stub_chars_after_write += sc
        else:
            stub_chars_pure += sc

        path_stats.append(
            PathReuse(
                path=path,
                full_reads=len(hits),
                stub_candidates=len(eligible),
                stub_chars=sc,
                had_write_between=had_write,
                last_full_chars=last.result_chars,
            )
        )

    path_stats.sort(key=lambda p: p.stub_chars, reverse=True)

    return {
        "total_reads": total_reads,
        "full_reads": len(full_ok),
        "partial_reads": len(partial),
        "total_read_result_chars": total_read_result_chars,
        "total_tool_result_chars": total_tool_result_chars,
        "paths_with_reuse": sum(1 for p in path_stats if p.stub_candidates > 0),
        "stub_chars": stub_chars,
        "stub_chars_after_write": stub_chars_after_write,
        "stub_chars_pure_reread": stub_chars_pure,
        "stub_count": stub_count,
        "top_paths": [asdict(p) for p in path_stats[:15]],
    }


def load_messages(path: Path) -> list[dict]:
    out = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return out


def analyze_sessions(
    recent: int | None = None,
    since_days: int | None = None,
    project: str | None = None,
    session_paths: list[Path] | None = None,
    min_chars: int = DEFAULT_MIN_CHARS,
) -> dict:
    sessions: list[SessionReuse] = []
    for path in iter_sessions(
        recent=recent, since_days=since_days, project=project, paths=session_paths
    ):
        msgs = load_messages(path)
        if not msgs:
            continue
        stats = analyze_session_messages(msgs, min_chars=min_chars)
        sessions.append(
            SessionReuse(
                session=path.name,
                project=extract_project(path),
                **stats,
            )
        )

    n = len(sessions)
    sum_read = sum(s.total_read_result_chars for s in sessions)
    sum_tool = sum(s.total_tool_result_chars for s in sessions)
    sum_stub = sum(s.stub_chars for s in sessions)
    sum_stub_w = sum(s.stub_chars_after_write for s in sessions)
    sum_stub_p = sum(s.stub_chars_pure_reread for s in sessions)
    sum_stub_n = sum(s.stub_count for s in sessions)
    sum_full = sum(s.full_reads for s in sessions)
    sum_reads = sum(s.total_reads for s in sessions)
    with_reuse = sum(1 for s in sessions if s.stub_count > 0)

    # Sessions ranked by stub potential
    ranked = sorted(sessions, key=lambda s: s.stub_chars, reverse=True)

    def pct(num: float, den: float) -> float | None:
        if den <= 0:
            return None
        return round(100.0 * num / den, 2)

    return {
        "meta": {
            "command": "read-reuse",
            "min_chars": min_chars,
            "policy": (
                "stub all but the last successful full `read` per normalized path "
                f"(result size >= {min_chars}); full = mode raw/default without offset/limit/target"
            ),
            "sessions_dir": str(get_sessions_dir()),
        },
        "totals": {
            "sessions": n,
            "sessions_with_stub_potential": with_reuse,
            "read_calls": sum_reads,
            "full_reads": sum_full,
            "stub_candidate_results": sum_stub_n,
            "read_result_chars": sum_read,
            "all_tool_result_chars": sum_tool,
            "stub_chars": sum_stub,
            "stub_chars_after_write": sum_stub_w,
            "stub_chars_pure_reread": sum_stub_p,
            "stub_share_of_read_results_pct": pct(sum_stub, sum_read),
            "stub_share_of_all_tool_results_pct": pct(sum_stub, sum_tool),
            "after_write_share_of_stub_pct": pct(sum_stub_w, sum_stub),
        },
        "top_sessions": [
            {
                "session": s.session,
                "project": s.project,
                "stub_chars": s.stub_chars,
                "stub_count": s.stub_count,
                "stub_chars_after_write": s.stub_chars_after_write,
                "stub_chars_pure_reread": s.stub_chars_pure_reread,
                "read_result_chars": s.total_read_result_chars,
                "tool_result_chars": s.total_tool_result_chars,
                "stub_share_of_reads_pct": pct(s.stub_chars, s.total_read_result_chars),
                "top_paths": s.top_paths[:5],
            }
            for s in ranked[:20]
            if s.stub_chars > 0
        ],
        "insights": _insights(
            n, with_reuse, sum_stub, sum_read, sum_tool, sum_stub_w, sum_stub_p
        ),
    }


def _insights(
    n: int,
    with_reuse: int,
    stub: int,
    read_chars: int,
    tool_chars: int,
    stub_w: int,
    stub_p: int,
) -> list[str]:
    out: list[str] = []
    if n == 0:
        return ["No sessions matched the filters."]
    out.append(
        f"{with_reuse}/{n} sessions have at least one supersedable full-read "
        f"({(100 * with_reuse / n):.0f}%)."
    )
    if read_chars > 0:
        out.append(
            f"Policy would drop ~{stub:,} chars of read results "
            f"({100 * stub / read_chars:.1f}% of all read-result chars, "
            f"{100 * stub / tool_chars:.1f}% of all tool-result chars)."
            if tool_chars
            else f"Policy would drop ~{stub:,} chars of read results "
            f"({100 * stub / read_chars:.1f}% of read-result chars)."
        )
    if stub > 0:
        out.append(
            f"Of stub chars: {100 * stub_w / stub:.0f}% sit behind a write/edit of the same path "
            f"(verify-reread pattern); {100 * stub_p / stub:.0f}% are pure re-reads without edit."
        )
    if stub and tool_chars and stub / tool_chars < 0.05:
        out.append(
            "Stub share of tool results is under 5% — ROI of an extension is likely low overall; "
            "check top_sessions for outlier long sessions only."
        )
    elif stub and tool_chars and stub / tool_chars >= 0.15:
        out.append(
            "Stub share of tool results is >= 15% — worth considering a narrow superseded-read trim "
            "on heavy sessions (watch prompt-cache prefix cost)."
        )
    return out


def print_report(report: dict) -> None:
    t = report["totals"]
    print("=== read-reuse (superseded full-read estimate) ===")
    print(f"Policy: {report['meta']['policy']}")
    print(f"min_chars: {report['meta']['min_chars']}")
    print()
    print(f"Sessions: {t['sessions']}  with stub potential: {t['sessions_with_stub_potential']}")
    print(f"Read calls: {t['read_calls']}  full: {t['full_reads']}  stub candidates: {t['stub_candidate_results']}")
    print(f"Read result chars:     {t['read_result_chars']:,}")
    print(f"All tool result chars: {t['all_tool_result_chars']:,}")
    print(f"Stub chars (total):    {t['stub_chars']:,}  ({t['stub_share_of_read_results_pct']}% of reads, {t['stub_share_of_all_tool_results_pct']}% of tools)")
    print(f"  after write/edit:    {t['stub_chars_after_write']:,}")
    print(f"  pure re-read:        {t['stub_chars_pure_reread']:,}")
    print()
    print("Insights:")
    for line in report["insights"]:
        print(f"  - {line}")
    print()
    if report["top_sessions"]:
        print("Top sessions by stub chars:")
        for s in report["top_sessions"][:12]:
            print(
                f"  [{s['project']}] {s['session']}: stub={s['stub_chars']:,} "
                f"(n={s['stub_count']}, after_write={s['stub_chars_after_write']:,}, "
                f"pure={s['stub_chars_pure_reread']:,}, "
                f"{s['stub_share_of_reads_pct']}% of session reads)"
            )
            for p in s.get("top_paths") or []:
                if p.get("stub_chars", 0) <= 0:
                    continue
                flag = "edit→reread" if p.get("had_write_between") else "reread"
                print(
                    f"      {flag} x{p['stub_candidates']} → {p['stub_chars']:,} chars  {p['path'][:100]}"
                )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Estimate supersedable full-read tool results")
    parser.add_argument("session", nargs="?", help="Optional single session .jsonl")
    parser.add_argument("--since", type=int, metavar="DAYS")
    parser.add_argument("--recent", type=int, metavar="N")
    parser.add_argument("--project", metavar="NAME")
    parser.add_argument(
        "--min-chars",
        type=int,
        default=DEFAULT_MIN_CHARS,
        help=f"Only count full-read results at least this large (default {DEFAULT_MIN_CHARS})",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    paths = [Path(args.session)] if args.session else None
    if paths and not paths[0].exists():
        print(f"File not found: {paths[0]}", file=sys.stderr)
        return 1

    report = analyze_sessions(
        recent=args.recent,
        since_days=args.since,
        project=args.project,
        session_paths=paths,
        min_chars=args.min_chars,
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
