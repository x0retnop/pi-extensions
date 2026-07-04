#!/usr/bin/env python3
"""Pi Session Inspector — analyze Pi agent session logs.

Usage:
  python pi_session_inspect.py <session.jsonl> [options]
  python pi_session_inspect.py --tool edit --recent
  python pi_session_inspect.py --tool edit --errors

Examples:
  # Show recent edit errors across all sessions
  python pi_session_inspect.py --edit-errors --recent 50

  # Show all real tool errors across recent sessions
  python pi_session_inspect.py --all-errors --real-errors --since 6

  # Show all tool calls in a session
  python pi_session_inspect.py /path/to/session.jsonl

  # Show edit tool calls and results with arguments
  python pi_session_inspect.py /path/to/session.jsonl --tool edit --calls --results
"""

import argparse
import json
import re
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


class _SafeStdout:
    """Wrap stdout so broken pipes on Windows do not crash the report."""

    def __init__(self, wrapped):
        self._wrapped = wrapped

    def write(self, data):
        try:
            return self._wrapped.write(data)
        except OSError:
            return 0

    def flush(self):
        try:
            return self._wrapped.flush()
        except OSError:
            return None

    def __getattr__(self, name):
        return getattr(self._wrapped, name)


def get_sessions_dir() -> Path:
    return Path.home() / ".pi" / "agent" / "sessions"


def iter_sessions(recent: int | None = None, since_days: int | None = None):
    """Yield .jsonl session paths, newest first.

    Supports both "N most recent" and "modified within last D days" filters.
    """
    sessions_dir = get_sessions_dir()
    if not sessions_dir.is_dir():
        return
    files = []
    cutoff = time.time() - since_days * 86400 if since_days else None
    for p in sessions_dir.rglob("*.jsonl"):
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue
        if cutoff is not None and mtime < cutoff:
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
    """Yield (line_index, message, toolResult) tuples.

    This is the original, fast helper that only looks at ``isError``.
    Use :func:`find_tool_result_errors` when you also need ``details.error``.
    """
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


def find_tool_result_errors(messages, tool_name: str | None = None):
    """Yield toolResult messages that failed in any way Pi records.

    Some failures (e.g. read-mode "Section not found", web-search summarizer
    errors, grep maxBuffer) set ``details.error`` or ``details.summarizer_error``
    without ``isError``.  This helper surfaces all of them.
    """
    for i, msg in enumerate(messages):
        if msg.get("type") != "message":
            continue
        m = msg.get("message", {})
        if m.get("role") != "toolResult":
            continue
        details = m.get("details", {})
        failed = (
            m.get("isError", False)
            or details.get("error")
            or details.get("summarizer_error")
        )
        if not failed:
            continue
        if tool_name and m.get("toolName") != tool_name:
            continue
        yield i, msg, m


def iter_trace_errors(messages):
    """Yield trace step errors buried in ``message.details.trace.steps``.

    These are usually web_search provider failures that do not surface as a
    normal toolResult error.
    """
    for i, msg in enumerate(messages):
        if msg.get("type") != "message":
            continue
        m = msg.get("message", {})
        trace = m.get("details", {}).get("trace")
        if not trace:
            continue
        for step in trace.get("steps", []):
            if step.get("error"):
                yield i, msg, step


def tool_result_text(m: dict) -> str:
    """Extract plain text from a toolResult message."""
    parts = []
    for item in m.get("content", []):
        if isinstance(item, dict):
            parts.append(item.get("text", ""))
    return "".join(parts)


def find_preceding_tool_call(
    messages, result_index: int, tool_name: str, max_lookback: int = 20
) -> dict | None:
    """Find the assistant toolCall that produced a given toolResult."""
    for j in range(result_index - 1, max(-1, result_index - max_lookback), -1):
        msg = messages[j]
        if msg.get("type") != "message":
            continue
        if msg.get("message", {}).get("role") != "assistant":
            continue
        for tc in msg.get("message", {}).get("content", []):
            if tc.get("type") == "toolCall" and tc.get("name") == tool_name:
                return tc
    return None


def classify_error(tool_name: str, text: str, details: dict | None = None) -> str:
    """Classify a tool failure into a stable category string."""
    t = text.lower()
    d = details or {}

    if tool_name in ("edit", "multi_edit"):
        if "old_string not found" in t:
            return "edit_old_string_not_found"
        if "found" in t and "occurrences" in t:
            return "edit_ambiguous_match"
        if "batch edit failed" in t:
            return "edit_batch_failed"
        if "could not edit" in t or "failed" in t:
            return "edit_failed"
        return "edit_error"

    if tool_name == "read":
        if "section" in t and "not found" in t:
            return "read_section_not_found"
        if "enoent" in t:
            return "read_enoent"
        if "eisdir" in t:
            return "read_eisdir"
        if "offset" in t and "beyond" in t:
            return "read_offset_beyond"
        return "read_error"

    if tool_name == "grep":
        if "maxbuffer" in t or "max_buffer" in t:
            return "grep_maxbuffer"
        if "regex parse error" in t:
            return "grep_regex_error"
        if "io error" in t:
            return "grep_io_error"
        return "grep_error"

    if tool_name == "web_search":
        if d.get("summarizer_error") or "summariz" in t:
            return "web_search_summarizer"
        if "backend error" in t or "terminated" in t:
            return "web_search_backend"
        return "web_search_error"

    if tool_name == "session_memory":
        return "session_memory_error"

    if tool_name == "bash":
        # The most common false positive: grep/test/condition with no matches.
        if text.strip().startswith("(no output)") and "exited with code 1" in t:
            return "bash_no_output"
        if "no module named" in t:
            return "bash_python_no_module"
        if "ran 0 tests" in t or "no tests ran" in t:
            return "bash_no_tests"
        if "[sudo] password" in t or "sudo: a password is required" in t:
            return "bash_sudo_password"
        if text.lstrip().startswith("Traceback"):
            return "bash_python_traceback"
        if "syntaxerror" in t:
            return "bash_python_syntax_error"
        if "syntax error" in t:
            return "bash_shell_syntax_error"
        if "command timed out" in t:
            return "bash_timeout"
        if "element not found" in t:
            return "bash_element_not_found"
        if "navigation failed" in t:
            return "bash_navigation_failed"
        if "ssh protocol banner" in t or "kex_exchange_identification" in t:
            return "bash_ssh"
        if text.strip().startswith("usage:"):
            return "bash_usage"
        if "no such file or directory" in t:
            return "bash_enoent"
        if "permission denied" in t:
            return "bash_permission_denied"
        if "command aborted" in t:
            return "bash_aborted"
        if "% total" in t or text.strip().startswith("curl:"):
            return "bash_curl"
        if "pinging" in t:
            return "bash_ping"
        if "connection" in t:
            return "bash_connection"
        return "bash_other"

    return "other"


# Categories that are usually noise rather than real failures.
NOISE_CATEGORIES = {
    "bash_no_output",
    "read_section_not_found",
}


def matches_noise_patterns(text: str, patterns: list[str]) -> bool:
    if not patterns:
        return False
    for pattern in patterns:
        if re.search(pattern, text, re.IGNORECASE):
            return True
    return False


def summarize_session(path: Path, args):
    messages = list(iter_messages(path))
    mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    print(f"\n=== {path.name} ({len(messages)} messages, {mtime.isoformat()}) ===")

    if args.calls:
        for idx, _, tc in find_tool_calls(messages, args.tool):
            name = tc.get("name")
            arguments = tc.get("arguments", {})
            print(f"\n[{idx + 1}] CALL {name}")
            print(json.dumps(arguments, ensure_ascii=False, indent=2))

    if args.results:
        for idx, _, m in find_tool_results(messages, args.tool, errors_only=args.errors):
            text = tool_result_text(m)
            err = m.get("isError", False)
            cat = classify_error(m.get("toolName", "?"), text, m.get("details", {})) if err else "-"
            print(f"\n[{idx + 1}] RESULT error={err} category={cat} tool={m.get('toolName')}")
            print(text[: args.max_chars])

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
            for _, _, m in find_tool_result_errors(messages, None):
                cat = classify_error(m.get("toolName", "?"), tool_result_text(m), m.get("details", {}))
                err_counts[cat] += 1
            print("Error counts by category:")
            for name, n in err_counts.most_common():
                print(f"  {name}: {n}")


def inspect_edit_errors(
    recent: int | None = None,
    since_days: int | None = None,
    max_chars: int = 800,
):
    """Specialized report for edit/multi_edit tool failures."""
    errors = []
    for path in iter_sessions(recent=recent, since_days=since_days):
        messages = list(iter_messages(path))
        for tool_name in ("edit", "multi_edit"):
            for i, msg, m in find_tool_results(messages, tool_name, errors_only=True):
                text = tool_result_text(m)
                tc = find_preceding_tool_call(messages, i, tool_name)
                errors.append(
                    {
                        "session": str(path),
                        "line": i + 1,
                        "tool": tool_name,
                        "result": text,
                        "args": tc.get("arguments", {}) if tc else None,
                    }
                )

    print(f"Found {len(errors)} edit failures.\n")
    for e in errors:
        print("=" * 60)
        print(f"Session: {Path(e['session']).name}")
        print(f"Line: {e['line']}  Tool: {e['tool']}")
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


def inspect_all_errors(
    recent: int | None = None,
    since_days: int | None = None,
    real_only: bool = False,
    noise_patterns: list[str] | None = None,
    tool_name: str | None = None,
    category: str | None = None,
    max_chars: int = 600,
):
    """Cross-session report of tool failures including non-obvious ones."""
    errors = []
    counts = Counter()

    for path in iter_sessions(recent=recent, since_days=since_days):
        messages = list(iter_messages(path))

        # Normal toolResult errors (isError) and Pi-recorded details errors.
        for i, msg, m in find_tool_result_errors(messages, tool_name):
            text = tool_result_text(m)
            tool = m.get("toolName", "?")
            cat = classify_error(tool, text, m.get("details", {}))
            counts[cat] += 1
            if category and cat != category:
                continue
            if real_only and cat in NOISE_CATEGORIES:
                continue
            if matches_noise_patterns(text, noise_patterns):
                continue
            tc = find_preceding_tool_call(messages, i, tool)
            errors.append(
                {
                    "session": str(path),
                    "line": i + 1,
                    "tool": tool,
                    "category": cat,
                    "result": text,
                    "call": tc,
                }
            )

        # Trace step errors (e.g. web_search provider timeouts).
        for i, msg, step in iter_trace_errors(messages):
            tool = msg.get("message", {}).get("toolName", "?")
            if tool_name and tool != tool_name:
                continue
            cat = "web_search_trace_error"
            counts[cat] += 1
            if category and cat != category:
                continue
            text = step.get("error", "")
            if matches_noise_patterns(text, noise_patterns):
                continue
            tc = find_preceding_tool_call(messages, i, tool)
            errors.append(
                {
                    "session": str(path),
                    "line": i + 1,
                    "tool": tool,
                    "category": cat,
                    "result": json.dumps(step, ensure_ascii=False),
                    "call": tc,
                }
            )

    header = f"Found {len(errors)} errors"
    if tool_name:
        header += f" for tool={tool_name}"
    if category:
        header += f" in category={category}"
    if real_only:
        header += " (noise filtered)"
    print(header + ".\n")

    print("Counts by category (all sessions, before per-category filtering):")
    for cat, n in counts.most_common():
        print(f"  {cat}: {n}")
    print()

    for e in errors:
        print("=" * 60)
        print(f"Session: {Path(e['session']).name}")
        print(f"Line: {e['line']}  Tool: {e['tool']}  Category: {e['category']}")
        call_args = e["call"].get("arguments", {}) if e["call"] else {}
        if call_args:
            compact = {}
            for k, v in call_args.items():
                if isinstance(v, str) and len(v) > 120:
                    compact[k] = v[:120] + "..."
                else:
                    compact[k] = v
            print(f"Call: {json.dumps(compact, ensure_ascii=False)}")
        print(f"Result: {e['result'][:max_chars]}")


def inspect_model_retries(
    recent: int | None = None, since_days: int | None = None
):
    """Report custom_message a-retry-trigger events (indicates model/API failures)."""
    retries = []
    for path in iter_sessions(recent=recent, since_days=since_days):
        for msg in iter_messages(path):
            if (
                msg.get("type") == "custom_message"
                and msg.get("customType") == "a-retry-trigger"
            ):
                retries.append(
                    {
                        "session": str(path),
                        "timestamp": msg.get("timestamp"),
                        "parent_id": msg.get("parentId"),
                    }
                )
    print(f"Found {len(retries)} model retry triggers.\n")
    for r in retries:
        print(
            f"Session: {Path(r['session']).name}  parent_id={r['parent_id']}  ts={r['timestamp']}"
        )


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    sys.stdout = _SafeStdout(sys.stdout)
    parser = argparse.ArgumentParser(description="Inspect Pi agent session logs.")
    parser.add_argument("session", nargs="?", help="Path to session .jsonl file")
    parser.add_argument("--tool", help="Filter by tool name")
    parser.add_argument("--calls", action="store_true", help="Show tool calls")
    parser.add_argument("--results", action="store_true", help="Show tool results")
    parser.add_argument("--errors", action="store_true", help="Show only errors")
    parser.add_argument(
        "--recent", type=int, metavar="N", help="Inspect N most recent sessions"
    )
    parser.add_argument(
        "--since",
        type=int,
        metavar="DAYS",
        help="Inspect sessions modified within the last N days",
    )
    parser.add_argument(
        "--max-chars", type=int, default=2000, help="Max chars per result"
    )
    parser.add_argument(
        "--edit-errors", action="store_true", help="Specialized edit error report"
    )
    parser.add_argument(
        "--all-errors",
        action="store_true",
        help="Cross-session error report for all tools and recorded failures",
    )
    parser.add_argument(
        "--real-errors",
        action="store_true",
        help="Filter common false positives (e.g. bash no-output exit 1, read section not found)",
    )
    parser.add_argument(
        "--noise",
        action="append",
        default=[],
        help="Additional regex patterns to treat as noise (repeatable)",
    )
    parser.add_argument(
        "--category",
        help="Filter errors by category (e.g. bash_timeout, read_enoent, web_search_trace_error)",
    )
    parser.add_argument(
        "--retries", action="store_true", help="Show model retry triggers"
    )
    args = parser.parse_args()

    if args.edit_errors:
        inspect_edit_errors(
            recent=args.recent, since_days=args.since, max_chars=args.max_chars
        )
        return

    if args.all_errors:
        inspect_all_errors(
            recent=args.recent,
            since_days=args.since,
            real_only=args.real_errors,
            noise_patterns=args.noise,
            tool_name=args.tool,
            category=args.category,
            max_chars=args.max_chars,
        )
        return

    if args.retries:
        inspect_model_retries(recent=args.recent, since_days=args.since)
        return

    if args.session:
        path = Path(args.session)
        if not path.exists():
            print(f"File not found: {path}", file=sys.stderr)
            sys.exit(1)
        summarize_session(path, args)
    elif args.recent or args.since:
        for path in iter_sessions(recent=args.recent, since_days=args.since):
            summarize_session(path, args)
    else:
        # Default: list recent sessions
        print("Recent sessions:")
        for path in iter_sessions(recent=20):
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
            print(f"  {mtime.isoformat()}  {path}")
        print("\nUse --edit-errors for quick edit failure report,")
        print("    --all-errors --real-errors for real issues across sessions,")
        print("    --retries for model retry triggers.")


if __name__ == "__main__":
    main()
