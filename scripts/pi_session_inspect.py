#!/usr/bin/env python3
"""Pi Session Inspector — analyze Pi agent session logs.

Usage:
  python pi_session_inspect.py <session.jsonl> [options]
  python pi_session_inspect.py --tool edit --recent
  python pi_session_inspect.py --tool edit --errors

Examples:
  # Show recent edit errors across all sessions
  python pi_session_inspect.py --tool edit --errors --recent 50

  # Show all tool calls in a session
  python pi_session_inspect.py /path/to/session.jsonl

  # Show edit tool calls and results with arguments
  python pi_session_inspect.py /path/to/session.jsonl --tool edit --calls --results
"""

import argparse
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def get_sessions_dir() -> Path:
    return Path.home() / ".pi" / "agent" / "sessions"


def iter_sessions(recent: int | None = None):
    sessions_dir = get_sessions_dir()
    if not sessions_dir.is_dir():
        return
    files = []
    for p in sessions_dir.rglob("*.jsonl"):
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue
        files.append((mtime, p))
    files.sort(reverse=True)
    if recent:
        files = files[:recent]
    for _, p in files:
        yield p


def iter_messages(path: Path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def find_tool_calls(messages, tool_name: str | None = None):
    """Yield (line_index, message, tool_call) tuples."""
    for i, msg in enumerate(messages):
        if msg.get("type") != "message":
            continue
        content = msg.get("message", {}).get("content", [])
        if msg.get("message", {}).get("role") != "assistant":
            continue
        for tc in content:
            if tc.get("type") != "toolCall":
                continue
            if tool_name and tc.get("name") != tool_name:
                continue
            yield i, msg, tc


def find_tool_results(messages, tool_name: str | None = None, errors_only: bool = False):
    for i, msg in enumerate(messages):
        if msg.get("type") != "message":
            continue
        m = msg.get("message", {})
        if m.get("role") != "toolResult":
            continue
        if tool_name and m.get("toolName") != tool_name:
            continue
        if errors_only and not m.get("isError", False):
            continue
        yield i, msg, m


def summarize_session(path: Path, args):
    messages = list(iter_messages(path))
    print(f"\n=== {path} ({len(messages)} messages) ===")

    if args.calls:
        for idx, _, tc in find_tool_calls(messages, args.tool):
            name = tc.get("name")
            arguments = tc.get("arguments", {})
            print(f"\n[{idx + 1}] CALL {name}")
            print(json.dumps(arguments, ensure_ascii=False, indent=2))

    if args.results:
        for idx, _, m in find_tool_results(messages, args.tool, errors_only=args.errors):
            text = m.get("content", [{}])[0].get("text", "")
            err = m.get("isError", False)
            print(f"\n[{idx + 1}] RESULT error={err} tool={m.get('toolName')}")
            print(text[:args.max_chars])

    if not args.calls and not args.results:
        # Default summary: tool counts
        counts = Counter()
        for _, _, tc in find_tool_calls(messages, None):
            counts[tc.get("name", "?")] += 1
        print("Tool call counts:")
        for name, n in counts.most_common():
            print(f"  {name}: {n}")

        if args.errors:
            err_counts = Counter()
            for _, _, m in find_tool_results(messages, None, errors_only=True):
                err_counts[m.get("toolName", "?")] += 1
            print("Error counts:")
            for name, n in err_counts.most_common():
                print(f"  {name}: {n}")


def inspect_edit_errors(recent: int = 50, max_chars: int = 800):
    """Specialized report for edit tool failures."""
    errors = []
    for path in iter_sessions(recent=recent):
        messages = list(iter_messages(path))
        for i, msg, m in find_tool_results(messages, "edit", errors_only=True):
            text = m.get("content", [{}])[0].get("text", "")
            if "unmatched" not in text.lower() and "could not find" not in text.lower() and "failed" not in text.lower():
                continue
            # Find preceding assistant toolCall
            call_args = None
            for j in range(i - 1, max(-1, i - 20), -1):
                if messages[j].get("type") != "message":
                    continue
                if messages[j].get("message", {}).get("role") != "assistant":
                    continue
                for tc in messages[j].get("message", {}).get("content", []):
                    if tc.get("type") == "toolCall" and tc.get("name") == "edit":
                        call_args = tc.get("arguments", {})
                        break
                if call_args is not None:
                    break
            errors.append({
                "session": str(path),
                "line": i + 1,
                "result": text,
                "args": call_args,
            })

    print(f"Found {len(errors)} edit failures in last {recent} sessions.\n")
    for e in errors:
        print("=" * 60)
        print(f"Session: {Path(e['session']).name}")
        print(f"Line: {e['line']}")
        print(f"Result: {e['result'][:max_chars]}")
        if e["args"]:
            path = e["args"].get("path")
            edits = e["args"].get("edits", [])
            multi = e["args"].get("multi", [])
            print(f"Path: {path}")
            print(f"Edits: {len(edits)}, Multi: {len(multi)}")
            for idx, item in enumerate((edits or multi)[:2]):
                if isinstance(item, dict):
                    ot = item.get("oldText", "")
                    print(f"  item[{idx}] oldText first 120: {repr(str(ot)[:120])}")


def main():
    parser = argparse.ArgumentParser(description="Inspect Pi agent session logs.")
    parser.add_argument("session", nargs="?", help="Path to session .jsonl file")
    parser.add_argument("--tool", help="Filter by tool name")
    parser.add_argument("--calls", action="store_true", help="Show tool calls")
    parser.add_argument("--results", action="store_true", help="Show tool results")
    parser.add_argument("--errors", action="store_true", help="Show only errors")
    parser.add_argument("--recent", type=int, metavar="N", help="Inspect N most recent sessions")
    parser.add_argument("--max-chars", type=int, default=2000, help="Max chars per result")
    parser.add_argument("--edit-errors", action="store_true", help="Specialized edit error report")
    args = parser.parse_args()

    if args.edit_errors:
        inspect_edit_errors(recent=args.recent or 50, max_chars=args.max_chars)
        return

    if args.session:
        path = Path(args.session)
        if not path.exists():
            print(f"File not found: {path}", file=sys.stderr)
            sys.exit(1)
        summarize_session(path, args)
    elif args.recent:
        for path in iter_sessions(recent=args.recent):
            summarize_session(path, args)
    else:
        # Default: list recent sessions
        print("Recent sessions:")
        for path in iter_sessions(recent=20):
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
            print(f"  {mtime.isoformat()}  {path}")
        print("\nUse --edit-errors for quick edit failure report.")


if __name__ == "__main__":
    main()
