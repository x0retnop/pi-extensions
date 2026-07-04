#!/usr/bin/env python3
"""Pi Session Inspector — analyze Pi agent session logs for LLM agents.

This script is designed to be consumed by another LLM agent that wants a
structured, high-signal view of recent sessions, tool failures, and actionable
patterns.  It supports both human-readable and JSON output.

Usage:
  python pi_session_inspect.py <session.jsonl> [options]
  python pi_session_inspect.py --summary --since 7
  python pi_session_inspect.py --all-errors --real-errors --since 6 --json
  python pi_session_inspect.py --tool bash --errors --recent 10 --json

Examples:
  # Compact LLM-friendly summary of recent sessions
  python pi_session_inspect.py --summary --since 3

  # Structured error analysis for agent self-improvement
  python pi_session_inspect.py --all-errors --real-errors --since 7 --json

  # Per-project health report
  python pi_session_inspect.py --summary --since 7 --json
"""

import argparse
import json
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
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


def extract_project(session_path: Path) -> str:
    """Best-effort project name from session folder structure.

    Sessions are stored under ``sessions/--C--<project>--/``.
    """
    name = session_path.parent.name
    if name.startswith("--C--") and name.endswith("--"):
        return name[5:-2]
    return name


def iter_sessions(
    recent: int | None = None,
    since_days: int | None = None,
    project: str | None = None,
):
    """Yield .jsonl session paths, newest first."""
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
        if project and extract_project(p) != project:
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
    """Yield (line_index, message, toolResult) tuples (isError only)."""
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
    """Yield toolResult messages that failed in any recorded way."""
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
    """Yield trace step errors buried in ``message.details.trace.steps``."""
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


def get_message_text(msg: dict) -> str:
    """Extract plain text from any message object."""
    m = msg.get("message", {})
    parts = []
    for item in m.get("content", []):
        if isinstance(item, dict):
            parts.append(item.get("text", ""))
    return "".join(parts)


def get_error_context(messages: list, idx: int, max_chars: int = 600) -> dict:
    """Collect surrounding user/assistant text for an error at index idx.

    Returns the nearest user prompt, any text-only assistant reasoning before
    the failing tool call, and the assistant's immediate response after the
    error.  This is what another LLM agent needs to understand *why* the tool
    was invoked and how the failure was handled.
    """
    ctx = {
        "before_user": [],
        "before_assistant": [],
        "after_assistant": [],
    }

    # Nearest user messages before the error (search back, keep 2 closest).
    user_hits = 0
    for j in range(idx - 1, -1, -1):
        m = messages[j].get("message", {})
        if m.get("role") == "user":
            text = get_message_text(messages[j]).strip()
            if text:
                ctx["before_user"].insert(0, text[:max_chars])
                user_hits += 1
                if user_hits >= 2:
                    break

    # Text-only assistant messages just before the failing tool call.
    # We look at the assistant message that emitted the toolCall, but also any
    # earlier text assistant messages in the same turn.
    for j in range(idx - 1, -1, -1):
        m = messages[j].get("message", {})
        if m.get("role") != "assistant":
            # Stop if we hit a user or non-message boundary; previous turn ends.
            if messages[j].get("type") != "message" or m.get("role") == "user":
                break
            continue
        text = get_message_text(messages[j]).strip()
        if text:
            ctx["before_assistant"].insert(0, text[:max_chars])
        # Stop after the assistant block that produced the tool call.
        break

    # Immediate assistant response after the error.
    for j in range(idx + 1, min(len(messages), idx + 10)):
        m = messages[j].get("message", {})
        if m.get("role") == "assistant":
            text = get_message_text(messages[j]).strip()
            if text:
                ctx["after_assistant"].append(text[:max_chars])
            break

    return ctx


SEVERITY = {
    "critical": {
        "edit_old_string_not_found",
        "edit_ambiguous_match",
        "edit_batch_failed",
        "edit_failed",
        "bash_python_traceback",
        "bash_python_syntax_error",
        "bash_shell_syntax_error",
        "bash_ssh",
        "session_memory_error",
        "web_search_backend",
        "web_search_trace_error",
        "grep_regex_error",
    },
    "warning": {
        "bash_timeout",
        "bash_enoent",
        "bash_permission_denied",
        "bash_element_not_found",
        "bash_navigation_failed",
        "bash_connection",
        "bash_aborted",
        "bash_usage",
        "bash_python_no_module",
        "bash_no_tests",
        "bash_sudo_password",
        "read_enoent",
        "read_eisdir",
        "read_offset_beyond",
        "grep_maxbuffer",
        "grep_io_error",
        "web_search_summarizer",
        "web_search_error",
        "read_error",
        "edit_error",
    },
    "info": {
        "bash_no_output",
        "read_section_not_found",
        "bash_ping",
        "bash_curl",
        "bash_other",
        "other",
    },
}

SEVERITY_BY_CATEGORY = {}
SEVERITY_RANK = {"info": 0, "warning": 1, "critical": 2}
for level, cats in SEVERITY.items():
    for cat in cats:
        SEVERITY_BY_CATEGORY[cat] = level


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


def severity(category: str) -> str:
    return SEVERITY_BY_CATEGORY.get(category, "info")


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


def normalize_error(text: str) -> str:
    """Create a template-like string for grouping similar errors."""
    # Replace paths, line numbers, ids, timestamps with placeholders.
    s = text
    s = re.sub(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", "<UUID>", s)
    s = re.sub(r"C:\\[^\s'\"]+", "<PATH>", s)
    s = re.sub(r"/c/[^\s'\"]+", "<PATH>", s)
    s = re.sub(r"/[^\s'\"]+/[^\s'\"]+", "<PATH>", s)
    s = re.sub(r"line \d+", "line <N>", s)
    s = re.sub(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", "<TS>", s)
    s = re.sub(r"\d+\.\d+\.\d+\.\d+", "<IP>", s)
    return s.strip()


def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def group_errors(errors: list, fuzzy: bool = False, threshold: float = 0.82) -> list:
    """Group errors by normalized message pattern.

    Default: exact grouping by ``normalize_error`` result (fast, deterministic).
    With ``fuzzy=True``: fuzzy matching within the same category, limited to the
    first representative of each group to keep cost low.
    """
    groups = []
    for e in errors:
        text = e["result"]
        norm = normalize_error(text)[:200]
        placed = False
        if fuzzy:
            for g in groups:
                # Only compare within same category; compare against representative.
                if g["category"] != e["category"]:
                    continue
                if similar(norm, g["normalized_pattern"]) >= threshold:
                    g["count"] += 1
                    g["examples"].append(e)
                    if len(g["examples"]) <= 3:
                        g["sample_texts"].append(text[:200])
                    placed = True
                    break
        else:
            key = (e["category"], norm)
            for g in groups:
                if g["key"] == key:
                    g["count"] += 1
                    g["examples"].append(e)
                    if len(g["examples"]) <= 3:
                        g["sample_texts"].append(text[:200])
                    placed = True
                    break
        if not placed:
            groups.append(
                {
                    "key": (e["category"], norm),
                    "pattern": text[:160],
                    "normalized_pattern": norm,
                    "category": e["category"],
                    "tool": e["tool"],
                    "severity": e["severity"],
                    "count": 1,
                    "examples": [e],
                    "sample_texts": [text[:200]],
                }
            )
    return groups


def compact_call_args(tc: dict | None, max_len: int = 200) -> dict:
    """Return a short dict of the toolCall arguments for reports."""
    if not tc:
        return {}
    args = tc.get("arguments", {})
    compact = {}
    for k, v in args.items():
        if isinstance(v, str) and len(v) > max_len:
            compact[k] = v[:max_len] + "..."
        else:
            compact[k] = v
    return compact


def collect_errors(
    recent: int | None = None,
    since_days: int | None = None,
    project: str | None = None,
    real_only: bool = False,
    noise_patterns: list[str] | None = None,
    tool_name: str | None = None,
    category: str | None = None,
    include_context: bool = True,
    min_severity: str | None = None,
) -> list:
    """Collect all tool failures across selected sessions."""
    errors = []
    for path in iter_sessions(recent=recent, since_days=since_days, project=project):
        messages = list(iter_messages(path))
        proj = extract_project(path)

        for i, msg, m in find_tool_result_errors(messages, tool_name):
            text = tool_result_text(m)
            tool = m.get("toolName", "?")
            cat = classify_error(tool, text, m.get("details", {}))
            if category and cat != category:
                continue
            sev = severity(cat)
            if real_only and cat in NOISE_CATEGORIES:
                continue
            if matches_noise_patterns(text, noise_patterns):
                continue
            if min_severity and SEVERITY_RANK.get(sev, 0) < SEVERITY_RANK.get(min_severity, 0):
                continue
            tc = find_preceding_tool_call(messages, i, tool)
            err = {
                "session": str(path),
                "session_name": path.name,
                "project": proj,
                "line": i + 1,
                "tool": tool,
                "category": cat,
                "severity": sev,
                "result": text,
                "call": compact_call_args(tc),
            }
            if include_context:
                err["context"] = get_error_context(messages, i)
            errors.append(err)

        for i, msg, step in iter_trace_errors(messages):
            tool = msg.get("message", {}).get("toolName", "?")
            if tool_name and tool != tool_name:
                continue
            cat = "web_search_trace_error"
            if category and cat != category:
                continue
            text = step.get("error", "")
            if real_only and cat in NOISE_CATEGORIES:
                continue
            if matches_noise_patterns(text, noise_patterns):
                continue
            tc = find_preceding_tool_call(messages, i, tool)
            err = {
                "session": str(path),
                "session_name": path.name,
                "project": proj,
                "line": i + 1,
                "tool": tool,
                "category": cat,
                "severity": severity(cat),
                "result": json.dumps(step, ensure_ascii=False),
                "call": compact_call_args(tc),
            }
            if include_context:
                err["context"] = get_error_context(messages, i)
            errors.append(err)

    return errors


def build_analytics(errors: list) -> dict:
    """Aggregate error data into analytics suitable for LLM consumption."""
    total = len(errors)
    by_category = Counter(e["category"] for e in errors)
    by_tool = Counter(e["tool"] for e in errors)
    by_severity = Counter(e["severity"] for e in errors)
    by_project = Counter(e["project"] for e in errors)

    session_errors = defaultdict(int)
    for e in errors:
        session_errors[e["session"]] += 1

    return {
        "total_errors": total,
        "by_category": dict(by_category.most_common()),
        "by_tool": dict(by_tool.most_common()),
        "by_severity": dict(by_severity.most_common()),
        "by_project": dict(by_project.most_common()),
        "sessions_with_errors": len(session_errors),
        "top_sessions": [
            {"session": Path(s).name, "count": c}
            for s, c in Counter(session_errors).most_common(10)
        ],
    }


def generate_insights(analytics: dict, groups: list) -> list:
    """Generate short, actionable insights for an LLM agent."""
    insights = []
    by_cat = analytics["by_category"]
    by_tool = analytics["by_tool"]
    by_sev = analytics["by_severity"]

    if by_cat.get("edit_old_string_not_found", 0) > 0:
        insights.append(
            "Edit failures dominate: agent edits stale code. Re-read the target file "
            "immediately before each edit, or use smaller, unique oldText snippets."
        )
    if by_cat.get("edit_ambiguous_match", 0) > 0:
        insights.append(
            "Ambiguous edit matches: oldText appears multiple times. Add surrounding "
            "context or use replace_all when appropriate."
        )
    if by_cat.get("bash_python_traceback", 0) > 0:
        insights.append(
            "Python tracebacks are frequent. Validate imports and argument shapes "
            "before running inline Python, and prefer scripts over long heredocs."
        )
    if by_cat.get("bash_python_no_module", 0) > 0:
        insights.append(
            "Missing Python modules. Check dependencies/venv before invoking tools."
        )
    if by_cat.get("bash_timeout", 0) > 0:
        insights.append(
            "Command timeouts. Add narrower filters, shorter loops, or increase "
            "timeout for known slow operations."
        )
    if by_cat.get("bash_ssh", 0) > 0 or by_cat.get("bash_connection", 0) > 0:
        insights.append(
            "SSH/connection errors are common. Verify hosts are reachable and "
            "credentials/keys are current before running remote commands."
        )
    if by_cat.get("read_enoent", 0) > 0:
        insights.append(
            "File-not-found read errors. Confirm paths exist (ls/dir) before read."
        )
    if by_cat.get("grep_maxbuffer", 0) > 0 or by_cat.get("grep_regex_error", 0) > 0:
        insights.append(
            "Grep misused: large outputs hit maxBuffer or regex is invalid. "
            "Use fixed_strings for literals and head_limit to cap results."
        )
    if by_sev.get("critical", 0) > analytics["total_errors"] * 0.3:
        insights.append(
            "Critical errors exceed 30% of all errors. Consider pausing to fix "
            "infrastructure (deps, paths, permissions) before continuing."
        )
    if by_tool.get("bash", 0) > analytics["total_errors"] * 0.6:
        insights.append(
            "bash is the noisiest tool. Review command construction, quoting, and "
            "path handling."
        )

    # Project-level insight
    by_proj = analytics["by_project"]
    if by_proj:
        top_proj = max(by_proj, key=by_proj.get)
        insights.append(
            f"Project '{top_proj}' has the most errors ({by_proj[top_proj]}). "
            "Focus improvement efforts there first."
        )

    return insights


def generate_action_plan(analytics: dict) -> list:
    """Turn analytics into prioritized, actionable tasks for an LLM agent."""
    plan = []
    by_cat = analytics["by_category"]
    total = analytics["total_errors"] or 1

    rules = [
        (
            "edit_old_string_not_found",
            "high",
            "Before every edit, re-read the target file and use a fresh, unique oldText snippet.",
        ),
        (
            "edit_ambiguous_match",
            "high",
            "Use replace_all:true or add surrounding context to oldText when the match is ambiguous.",
        ),
        (
            "bash_python_traceback",
            "high",
            "Validate inline Python in a scratch script first; check imports and types before running.",
        ),
        (
            "bash_python_no_module",
            "high",
            "Audit project dependencies/venv and install missing packages before running code.",
        ),
        (
            "bash_timeout",
            "medium",
            "Add narrower filters, chunked processing, or explicit timeout arguments to long commands.",
        ),
        (
            "bash_ssh",
            "medium",
            "Verify remote host reachability, keys, and known_hosts before SSH-dependent commands.",
        ),
        (
            "bash_connection",
            "medium",
            "Retry connection-sensitive operations with backoff and pre-flight connectivity checks.",
        ),
        (
            "read_enoent",
            "medium",
            "Confirm file existence (ls/dir/list) before read; handle optional files gracefully.",
        ),
        (
            "grep_maxbuffer",
            "medium",
            "Cap grep output with head_limit and use fixed_strings for literal code searches.",
        ),
        (
            "grep_regex_error",
            "medium",
            "Escape regex metacharacters or set fixed_strings:true for literal patterns.",
        ),
        (
            "web_search_trace_error",
            "low",
            "Check web_search provider health and retry with shorter queries if providers time out.",
        ),
        (
            "web_search_summarizer",
            "low",
            "Verify local summarizer service is running; fall back to raw results if needed.",
        ),
    ]

    for cat, priority, action in rules:
        count = by_cat.get(cat, 0)
        if count == 0:
            continue
        plan.append(
            {
                "priority": priority,
                "action": action,
                "reason": f"{cat} occurred {count} times ({count / total:.1%} of errors).",
                "affected_category": cat,
                "count": count,
            }
        )

    # Generic catch-all for any remaining critical category not in rules.
    for cat, count in by_cat.items():
        if severity(cat) == "critical" and not any(p["affected_category"] == cat for p in plan):
            plan.append(
                {
                    "priority": "medium",
                    "action": f"Investigate and reduce {cat} failures.",
                    "reason": f"{cat} occurred {count} times and is classified critical.",
                    "affected_category": cat,
                    "count": count,
                }
            )

    priority_rank = {"high": 0, "medium": 1, "low": 2}
    plan.sort(key=lambda x: (priority_rank.get(x["priority"], 99), -x["count"]))
    return plan


def build_tool_health(
    recent: int | None = None,
    since_days: int | None = None,
    project: str | None = None,
) -> dict:
    """Compute success/failure rates per tool across selected sessions."""
    tool_calls = Counter()
    tool_errors = Counter()
    for path in iter_sessions(recent=recent, since_days=since_days, project=project):
        messages = list(iter_messages(path))
        for _, _, tc in find_tool_calls(messages, None):
            tool_calls[tc.get("name", "?")] += 1
        for _, _, m in find_tool_result_errors(messages, None):
            tool_errors[m.get("toolName", "?")] += 1

    health = {}
    for tool, calls in tool_calls.most_common():
        errs = tool_errors.get(tool, 0)
        health[tool] = {
            "calls": calls,
            "errors": errs,
            "success_rate": round((calls - errs) / calls, 4) if calls else 0.0,
            "error_rate": round(errs / calls, 4) if calls else 0.0,
        }
    return health


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
    project: str | None = None,
    max_chars: int = 800,
):
    """Specialized report for edit/multi_edit tool failures."""
    errors = collect_errors(
        recent=recent,
        since_days=since_days,
        project=project,
        tool_name=None,
        real_only=False,
        noise_patterns=[],
        category=None,
        include_context=False,
    )
    errors = [e for e in errors if e["tool"] in ("edit", "multi_edit")]

    print(f"Found {len(errors)} edit failures.\n")
    for e in errors:
        print("=" * 60)
        print(f"Session: {e['session_name']}")
        print(f"Line: {e['line']}  Tool: {e['tool']}  Category: {e['category']}")
        print(f"Result: {e['result'][:max_chars]}")
        args = e.get("call", {})
        if args:
            path = args.get("path")
            edits = args.get("edits", [])
            multi = args.get("multi", [])
            print(f"Path: {path}")
            print(f"Edits: {len(edits)}, Multi: {len(multi)}")
            for idx, item in enumerate((edits or multi)[:2]):
                if isinstance(item, dict):
                    ot = item.get("oldText", "")
                    print(f"  item[{idx}] oldText first 120: {repr(str(ot)[:120])}")


def inspect_all_errors(
    recent: int | None = None,
    since_days: int | None = None,
    project: str | None = None,
    real_only: bool = False,
    noise_patterns: list[str] | None = None,
    tool_name: str | None = None,
    category: str | None = None,
    max_chars: int = 600,
    json_mode: bool = False,
    top: int = 20,
    include_context: bool = True,
    fuzzy_groups: bool = False,
    min_severity: str | None = None,
):
    """Cross-session report of tool failures including non-obvious ones."""
    errors = collect_errors(
        recent=recent,
        since_days=since_days,
        project=project,
        real_only=real_only,
        noise_patterns=noise_patterns,
        tool_name=tool_name,
        category=category,
        include_context=include_context,
        min_severity=min_severity,
    )
    analytics = build_analytics(errors)
    groups = group_errors(errors, fuzzy=fuzzy_groups)
    groups.sort(key=lambda g: (-(g["severity"] == "critical"), -g["count"], g["category"]))
    insights = generate_insights(analytics, groups)
    action_plan = generate_action_plan(analytics)

    if json_mode:
        output = {
            "meta": {
                "command": "all_errors",
                "real_only": real_only,
                "tool": tool_name,
                "category": category,
                "project": project,
            },
            "analytics": analytics,
            "insights": insights,
            "action_plan": action_plan,
            "pattern_groups": [
                {
                    "pattern": g["pattern"],
                    "category": g["category"],
                    "tool": g["tool"],
                    "severity": g["severity"],
                    "count": g["count"],
                    "samples": g["sample_texts"],
                    "example_sessions": [
                        Path(e["session"]).name for e in g["examples"][:3]
                    ],
                }
                for g in groups[:top]
            ],
            "errors": [
                {
                    "session_name": e["session_name"],
                    "project": e["project"],
                    "line": e["line"],
                    "tool": e["tool"],
                    "category": e["category"],
                    "severity": e["severity"],
                    "result": e["result"][:max_chars],
                    "call": e["call"],
                    "context": e.get("context") if include_context else None,
                }
                for e in errors[:top]
            ],
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    header = f"Found {len(errors)} errors"
    if tool_name:
        header += f" for tool={tool_name}"
    if category:
        header += f" in category={category}"
    if project:
        header += f" in project={project}"
    if real_only:
        header += " (noise filtered)"
    print(header + ".\n")

    print("Analytics:")
    print(json.dumps(analytics, ensure_ascii=False, indent=2))
    print()

    print("Insights:")
    for ins in insights:
        print(f"  • {ins}")
    print()

    print("Action plan:")
    for item in action_plan[:top]:
        print(f"  [{item['priority']}] {item['action']}")
        print(f"      reason: {item['reason']}")
    print()

    print(f"Top {top} error pattern groups:")
    for g in groups[:top]:
        print(
            f"  [{g['severity']}] {g['category']} ({g['tool']}) x{g['count']}: {g['pattern'][:120]}"
        )
    print()

    print("Sample errors:")
    for e in errors[:top]:
        print("=" * 60)
        print(
            f"Session: {e['session_name']}  Project: {e['project']}  "
            f"Line: {e['line']}  Tool: {e['tool']}  Category: {e['category']}  "
            f"Severity: {e['severity']}"
        )
        print(f"Call: {json.dumps(e['call'], ensure_ascii=False)}")
        print(f"Result: {e['result'][:max_chars]}")
        ctx = e.get("context")
        if ctx and include_context:
            if ctx.get("before_user"):
                print(f"User before: {ctx['before_user'][-1][:240]!r}")
            if ctx.get("after_assistant"):
                print(f"Assistant after: {ctx['after_assistant'][0][:240]!r}")


def inspect_summary(
    recent: int | None = None,
    since_days: int | None = None,
    project: str | None = None,
    json_mode: bool = False,
):
    """Compact cross-session summary: messages, tools, errors, health."""
    session_stats = []
    total_messages = 0
    total_tool_calls = Counter()
    all_errors = []

    for path in iter_sessions(recent=recent, since_days=since_days, project=project):
        messages = list(iter_messages(path))
        total_messages += len(messages)
        calls = Counter(tc.get("name", "?") for _, _, tc in find_tool_calls(messages, None))
        total_tool_calls.update(calls)
        errs = []
        for _, _, m in find_tool_result_errors(messages, None):
            cat = classify_error(
                m.get("toolName", "?"), tool_result_text(m), m.get("details", {})
            )
            errs.append(
                {
                    "session": str(path),
                    "session_name": path.name,
                    "project": extract_project(path),
                    "tool": m.get("toolName", "?"),
                    "category": cat,
                    "severity": severity(cat),
                }
            )
        all_errors.extend(errs)
        session_stats.append(
            {
                "session": path.name,
                "project": extract_project(path),
                "messages": len(messages),
                "tool_calls": dict(calls),
                "errors": len(errs),
                "critical_errors": sum(1 for e in errs if e["severity"] == "critical"),
                "mtime": datetime.fromtimestamp(
                    path.stat().st_mtime, tz=timezone.utc
                ).isoformat(),
            }
        )

    health = build_tool_health(
        recent=recent, since_days=since_days, project=project
    )
    analytics = build_analytics(all_errors)
    insights = generate_insights(analytics, [])
    action_plan = generate_action_plan(analytics)

    if json_mode:
        output = {
            "meta": {
                "command": "summary",
                "project": project,
            },
            "totals": {
                "sessions": len(session_stats),
                "messages": total_messages,
                "tool_calls": dict(total_tool_calls),
                "errors": len(all_errors),
            },
            "tool_health": health,
            "error_analytics": analytics,
            "insights": insights,
            "action_plan": action_plan,
            "sessions": session_stats,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    print(f"Sessions: {len(session_stats)}  Messages: {total_messages}  Errors: {len(all_errors)}\n")
    print("Tool health:")
    for tool, stats in health.items():
        print(
            f"  {tool}: calls={stats['calls']} errors={stats['errors']} "
            f"success_rate={stats['success_rate']:.1%}"
        )
    print("\nInsights:")
    for ins in insights:
        print(f"  • {ins}")
    print("\nAction plan:")
    for item in action_plan[:10]:
        print(f"  [{item['priority']}] {item['action']}")
        print(f"      reason: {item['reason']}")
    print("\nSessions:")
    for s in session_stats:
        print(
            f"  {s['session']} ({s['project']}): msgs={s['messages']} "
            f"errors={s['errors']} critical={s['critical_errors']}"
        )


def inspect_failure_chains(
    recent: int | None = None,
    since_days: int | None = None,
    project: str | None = None,
    real_only: bool = False,
    noise_patterns: list[str] | None = None,
    min_length: int = 3,
    json_mode: bool = False,
    min_severity: str | None = None,
):
    """Find sequences of consecutive tool failures within a single session.

    These "failure chains" often indicate an agent getting stuck: e.g. repeated
    edit failures, read-after-read misses, or cascading bash retries.
    """
    chains = []
    for path in iter_sessions(recent=recent, since_days=since_days, project=project):
        messages = list(iter_messages(path))
        current = []
        for i, msg in enumerate(messages):
            if msg.get("type") != "message":
                continue
            m = msg.get("message", {})
            role = m.get("role")
            if role == "user":
                # User intervention resets the chain.
                if len(current) >= min_length:
                    chains.append(_finalize_chain(path, messages, current))
                current = []
                continue
            if role != "toolResult":
                continue
            text = tool_result_text(m)
            tool = m.get("toolName", "?")
            cat = classify_error(tool, text, m.get("details", {}))
            sev = severity(cat)
            if real_only and cat in NOISE_CATEGORIES:
                # Treat noise as a success for chain purposes.
                if len(current) >= min_length:
                    chains.append(_finalize_chain(path, messages, current))
                current = []
                continue
            if matches_noise_patterns(text, noise_patterns):
                if len(current) >= min_length:
                    chains.append(_finalize_chain(path, messages, current))
                current = []
                continue
            if min_severity and SEVERITY_RANK.get(sev, 0) < SEVERITY_RANK.get(min_severity, 0):
                # Severity too low: break chain.
                if len(current) >= min_length:
                    chains.append(_finalize_chain(path, messages, current))
                current = []
                continue
            details = m.get("details", {})
            failed = m.get("isError", False) or details.get("error") or details.get("summarizer_error")
            if failed:
                current.append(
                    {
                        "line": i + 1,
                        "tool": tool,
                        "category": cat,
                        "severity": sev,
                        "result": text[:240],
                    }
                )
            else:
                if len(current) >= min_length:
                    chains.append(_finalize_chain(path, messages, current))
                current = []
        if len(current) >= min_length:
            chains.append(_finalize_chain(path, messages, current))

    if json_mode:
        print(json.dumps({"failure_chains": chains}, ensure_ascii=False, indent=2))
        return

    print(f"Found {len(chains)} failure chains (length >= {min_length}).\n")
    for c in chains:
        print("=" * 60)
        print(
            f"Session: {c['session_name']}  Project: {c['project']}  "
            f"length={c['length']}  tools={','.join(c['tools'])}  "
            f"categories={','.join(c['categories'])}"
        )
        for e in c["errors"]:
            print(f"  line {e['line']} [{e['severity']}] {e['tool']}: {e['result'][:100]}")


def _finalize_chain(path: Path, messages: list, current: list) -> dict:
    """Package a chain of consecutive errors with session context."""
    first_line = current[0]["line"]
    last_line = current[-1]["line"]
    ctx = get_error_context(messages, first_line - 1, max_chars=400)
    tools = list(dict.fromkeys(e["tool"] for e in current))
    cats = list(dict.fromkeys(e["category"] for e in current))
    return {
        "session": str(path),
        "session_name": path.name,
        "project": extract_project(path),
        "length": len(current),
        "start_line": first_line,
        "end_line": last_line,
        "tools": tools,
        "categories": cats,
        "errors": current,
        "context": ctx,
    }


def inspect_model_retries(
    recent: int | None = None,
    since_days: int | None = None,
    project: str | None = None,
    json_mode: bool = False,
):
    """Report custom_message a-retry-trigger events (indicates model/API failures)."""
    retries = []
    for path in iter_sessions(recent=recent, since_days=since_days, project=project):
        for msg in iter_messages(path):
            if (
                msg.get("type") == "custom_message"
                and msg.get("customType") == "a-retry-trigger"
            ):
                retries.append(
                    {
                        "session": str(path),
                        "session_name": path.name,
                        "project": extract_project(path),
                        "timestamp": msg.get("timestamp"),
                        "parent_id": msg.get("parentId"),
                    }
                )
    if json_mode:
        print(json.dumps({"retries": retries}, ensure_ascii=False, indent=2))
        return
    print(f"Found {len(retries)} model retry triggers.\n")
    for r in retries:
        print(
            f"Session: {r['session_name']} ({r['project']}) "
            f"parent_id={r['parent_id']}  ts={r['timestamp']}"
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
        "--project",
        metavar="NAME",
        help="Filter by project folder name (the part between --C-- and --)",
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
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Compact cross-session summary with tool health and insights",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output structured JSON for consumption by another agent",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=20,
        help="Number of top errors/patterns to include in output",
    )
    parser.add_argument(
        "--no-context",
        action="store_true",
        help="Do not include surrounding user/assistant context for errors",
    )
    parser.add_argument(
        "--fuzzy-groups",
        action="store_true",
        help="Use fuzzy string grouping for error patterns (slower, fewer groups)",
    )
    parser.add_argument(
        "--chains",
        action="store_true",
        help="Find consecutive failure chains within sessions",
    )
    parser.add_argument(
        "--chain-length",
        type=int,
        default=3,
        metavar="N",
        help="Minimum length of a failure chain to report",
    )
    parser.add_argument(
        "--min-severity",
        choices=["info", "warning", "critical"],
        help="Only include errors with at least this severity",
    )
    args = parser.parse_args()

    if args.edit_errors:
        inspect_edit_errors(
            recent=args.recent,
            since_days=args.since,
            project=args.project,
            max_chars=args.max_chars,
        )
        return

    if args.all_errors:
        inspect_all_errors(
            recent=args.recent,
            since_days=args.since,
            project=args.project,
            real_only=args.real_errors,
            noise_patterns=args.noise,
            tool_name=args.tool,
            category=args.category,
            max_chars=args.max_chars,
            json_mode=args.json,
            top=args.top,
            include_context=not args.no_context,
            fuzzy_groups=args.fuzzy_groups,
            min_severity=args.min_severity,
        )
        return

    if args.retries:
        inspect_model_retries(
            recent=args.recent,
            since_days=args.since,
            project=args.project,
            json_mode=args.json,
        )
        return

    if args.chains:
        inspect_failure_chains(
            recent=args.recent,
            since_days=args.since,
            project=args.project,
            real_only=args.real_errors,
            noise_patterns=args.noise,
            min_length=args.chain_length,
            json_mode=args.json,
            min_severity=args.min_severity,
        )
        return

    if args.summary:
        inspect_summary(
            recent=args.recent,
            since_days=args.since,
            project=args.project,
            json_mode=args.json,
        )
        return

    if args.session:
        path = Path(args.session)
        if not path.exists():
            print(f"File not found: {path}", file=sys.stderr)
            sys.exit(1)
        summarize_session(path, args)
    elif args.recent or args.since or args.project:
        for path in iter_sessions(
            recent=args.recent, since_days=args.since, project=args.project
        ):
            summarize_session(path, args)
    else:
        # Default: list recent sessions
        print("Recent sessions:")
        for path in iter_sessions(recent=20):
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
            print(f"  {mtime.isoformat()}  {path}")
        print("\nAgent-oriented usage:")
        print("  --summary --since 7 --json          # compact health report")
        print("  --all-errors --real-errors --since 7 --json")
        print("  --retries --since 7 --json")
        print("  --project '10x001-domain' --summary --since 3")


if __name__ == "__main__":
    main()
