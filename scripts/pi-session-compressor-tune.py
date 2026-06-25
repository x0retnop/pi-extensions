#!/usr/bin/env python3
"""Pi Session Compressor Tuner — analyze Pi agent sessions and suggest context-compressor settings.

Reads ~/.pi/agent/sessions/**/*.jsonl, extracts message statistics, estimates context
usage, simulates the context-compressor trigger logic, and prints tuning recommendations.

Examples:
    python scripts/pi-session-compressor-tune.py
    python scripts/pi-session-compressor-tune.py --recent 30 --min-messages 40
    python scripts/pi-session-compressor-tune.py --cwd-contains "pi extensions" --json
"""

import argparse
import json
import math
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any

SETTINGS_PATH = Path.home() / ".pi" / "agent" / "settings.json"
SESSIONS_DIR = Path.home() / ".pi" / "agent" / "sessions"

DEFAULT_SETTINGS = {
    "enabled": True,
    "promptName": "balanced",
    "mode": "auto",
    "tokenThresholdPercent": 55,
    "stepInterval": 10,
    "minMessagesToSummarize": 6,
    "maxSummaryTokens": 2000,
    "trimAfterCompress": False,
    "keptRecentMessages": 8,
    "debug": False,
}

# Best-effort context-window map for models commonly used with Pi.
# Override with --context-window if you know the exact value.
MODEL_CONTEXT_WINDOWS = {
    "kimi-k2.6": 256_000,
    "kimi-for-coding": 128_000,
    "kimi-k2": 256_000,
    "kimi-k1.5": 128_000,
    "claude-sonnet-4-20250514": 200_000,
    "claude-sonnet-4": 200_000,
    "claude-3-7-sonnet": 200_000,
    "claude-3-5-sonnet": 200_000,
    "claude-3-5-haiku": 200_000,
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "o3-mini": 200_000,
    "o1-mini": 128_000,
    "gemini-2.5-pro": 1_000_000,
    "gemini-2.0-flash": 1_000_000,
}

DEFAULT_CONTEXT_WINDOW = 128_000
TOKENS_PER_CHAR = 0.25


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze Pi sessions and suggest context-compressor settings."
    )
    parser.add_argument(
        "--recent",
        type=int,
        metavar="N",
        help="Analyze only the N most recent sessions (default: all).",
    )
    parser.add_argument(
        "--min-messages",
        type=int,
        default=20,
        metavar="M",
        help="Ignore sessions with fewer than M messages (default: 20).",
    )
    parser.add_argument(
        "--long-messages",
        type=int,
        default=40,
        metavar="M",
        help="Threshold for treating a session as 'long' (default: 40).",
    )
    parser.add_argument(
        "--cwd-contains",
        type=str,
        metavar="STR",
        help="Only include sessions whose cwd contains STR (case-insensitive).",
    )
    parser.add_argument(
        "--context-window",
        type=int,
        metavar="N",
        help="Override the model context window used for usage estimates.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output raw JSON instead of the human-readable report.",
    )
    parser.add_argument(
        "--exclude-thinking",
        action="store_true",
        help="Exclude assistant 'thinking' blocks from token estimates.",
    )
    return parser.parse_args()


def load_current_settings() -> dict[str, Any]:
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    raw = data.get("contextCompressor", {})
    return {**DEFAULT_SETTINGS, **raw}


def context_window_for(model_id: str | None, override: int | None) -> int:
    if override:
        return override
    if not model_id:
        return DEFAULT_CONTEXT_WINDOW
    # Try exact match first, then partial.
    if model_id in MODEL_CONTEXT_WINDOWS:
        return MODEL_CONTEXT_WINDOWS[model_id]
    for key, value in MODEL_CONTEXT_WINDOWS.items():
        if key in model_id or model_id in key:
            return value
    return DEFAULT_CONTEXT_WINDOW


def parse_timestamp(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


def iter_sessions(recent: int | None = None):
    if not SESSIONS_DIR.is_dir():
        return
    files: list[tuple[float, Path]] = []
    for p in SESSIONS_DIR.rglob("*.jsonl"):
        try:
            files.append((p.stat().st_mtime, p))
        except OSError:
            continue
    files.sort(reverse=True)
    if recent:
        files = files[:recent]
    for _, p in files:
        yield p


def extract_text(message_obj: dict[str, Any]) -> str:
    """Extract a rough text representation of a message for token estimation."""
    parts: list[str] = []
    if isinstance(message_obj.get("text"), str):
        parts.append(message_obj["text"])
    content = message_obj.get("content") or []
    if isinstance(content, dict):
        content = [content]
    for item in content:
        if not isinstance(item, dict):
            continue
        typ = item.get("type")
        if typ == "text" and isinstance(item.get("text"), str):
            parts.append(item["text"])
        elif typ == "thinking" and isinstance(item.get("thinking"), str):
            parts.append(item["thinking"])
        elif typ == "toolCall":
            args = item.get("arguments")
            if args is not None:
                try:
                    parts.append(json.dumps(args, ensure_ascii=False))
                except (TypeError, ValueError):
                    parts.append(str(args))
    return "\n".join(parts)


def estimate_tokens(text: str) -> float:
    return len(text) * TOKENS_PER_CHAR


def _trim_context(context: list[float], window: int) -> None:
    """Drop oldest messages until context fits the model window."""
    total = sum(context)
    while total > window and context:
        total -= context.pop(0)


def analyze_session(path: Path, args: argparse.Namespace, settings: dict[str, Any]):
    messages: list[dict[str, Any]] = []
    session_event: dict[str, Any] | None = None
    model_ids: list[str] = []
    timestamps: list[datetime] = []

    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = parse_timestamp(msg.get("timestamp"))
                if ts:
                    timestamps.append(ts)
                typ = msg.get("type")
                if typ == "session":
                    session_event = msg
                elif typ == "model_change":
                    mid = msg.get("modelId")
                    if mid:
                        model_ids.append(mid)
                elif typ == "message":
                    messages.append(msg)
    except OSError as e:
        return {"error": str(e)}

    if len(messages) < args.min_messages:
        return None

    if args.cwd_contains and session_event:
        cwd = str(session_event.get("cwd", "")).lower()
        if args.cwd_contains.lower() not in cwd:
            return None

    # Per-message token estimates.
    msg_tokens: list[float] = []
    roles: Counter[str] = Counter()
    tool_calls: Counter[str] = Counter()
    tool_result_count = 0
    user_count = 0
    assistant_count = 0
    total_tool_result_tokens = 0.0
    total_assistant_tokens = 0.0

    for msg in messages:
        m = msg.get("message", {})
        role = m.get("role") if isinstance(m, dict) else None
        roles[role] += 1
        text = extract_text(m)
        if args.exclude_thinking:
            # Remove thinking blocks after extraction for a conservative estimate.
            # extract_text already joined them; re-extract without thinking.
            text = _extract_text_without_thinking(m)
        tokens = estimate_tokens(text)
        msg_tokens.append(tokens)
        if role == "user":
            user_count += 1
        elif role == "assistant":
            assistant_count += 1
            total_assistant_tokens += tokens
            for c in m.get("content", []):
                if isinstance(c, dict) and c.get("type") == "toolCall":
                    tool_calls[c.get("name", "?")] += 1
        elif role == "toolResult":
            tool_result_count += 1
            total_tool_result_tokens += tokens

    model_id = model_ids[-1] if model_ids else None
    window = context_window_for(model_id, args.context_window)

    # Simulate compressor behavior with current settings.
    sim = simulate_compressor(messages, msg_tokens, settings, window)

    # Compute message chunks between user messages (useful for keptRecentMessages).
    user_chunk_sizes: list[int] = []
    current_chunk = 0
    for msg in messages:
        role = msg.get("message", {}).get("role")
        if role == "user":
            if current_chunk:
                user_chunk_sizes.append(current_chunk)
            current_chunk = 0
        elif role in ("assistant", "toolResult"):
            current_chunk += 1
    if current_chunk:
        user_chunk_sizes.append(current_chunk)

    duration_seconds = 0.0
    if len(timestamps) >= 2:
        duration_seconds = (max(timestamps) - min(timestamps)).total_seconds()

    cumulative_tokens = sum(msg_tokens)

    return {
        "path": str(path),
        "name": path.name,
        "cwd": session_event.get("cwd") if session_event else None,
        "model_id": model_id,
        "context_window": window,
        "duration_seconds": duration_seconds,
        "duration_minutes": duration_seconds / 60.0,
        "message_count": len(messages),
        "roles": dict(roles),
        "user_count": user_count,
        "assistant_count": assistant_count,
        "tool_result_count": tool_result_count,
        "tool_calls": dict(tool_calls),
        "total_tokens": cumulative_tokens,
        "peak_tokens": sim["peak_tokens"],
        "peak_percent": sim["peak_percent"],
        "tool_result_token_share": total_tool_result_tokens / cumulative_tokens * 100 if cumulative_tokens else 0.0,
        "triggers": sim["triggers"],
        "user_chunk_sizes": user_chunk_sizes,
        "is_long": len(messages) >= args.long_messages,
    }


def _extract_text_without_thinking(message_obj: dict[str, Any]) -> str:
    """Variant of extract_text that skips reasoning/thinking blocks."""
    parts: list[str] = []
    if isinstance(message_obj.get("text"), str):
        parts.append(message_obj["text"])
    content = message_obj.get("content") or []
    if isinstance(content, dict):
        content = [content]
    for item in content:
        if not isinstance(item, dict):
            continue
        typ = item.get("type")
        if typ == "text" and isinstance(item.get("text"), str):
            parts.append(item["text"])
        elif typ == "toolCall":
            args = item.get("arguments")
            if args is not None:
                try:
                    parts.append(json.dumps(args, ensure_ascii=False))
                except (TypeError, ValueError):
                    parts.append(str(args))
    return "\n".join(parts)


def simulate_compressor(
    messages: list[dict[str, Any]],
    msg_tokens: list[float],
    settings: dict[str, Any],
    window: int,
) -> dict[str, Any]:
    """Simulate when context-compressor would fire under the given settings.

    Maintains a rolling context capped at the model window so usage estimates do
    not exceed 100%.
    """
    triggers: list[dict[str, Any]] = []
    context: list[float] = []  # token counts currently in context
    step_counter = 0
    last_step = 0
    peak_tokens = 0.0
    peak_percent = 0.0

    threshold = settings.get("tokenThresholdPercent", 55)
    step_interval = settings.get("stepInterval", 10)
    min_messages = settings.get("minMessagesToSummarize", 6)
    trim = settings.get("trimAfterCompress", False)
    keep = settings.get("keptRecentMessages", 8)
    summary_tokens = settings.get("maxSummaryTokens", 2000)

    prev_role = None
    for idx, msg in enumerate(messages):
        m = msg.get("message", {})
        role = m.get("role")
        tokens = msg_tokens[idx]

        # Count steps by actual actions: each user request and each completed
        # tool call (toolResult), matching the extension's semantics.
        if role == "user" or role == "toolResult":
            step_counter += 1

        if role == "assistant":
            _trim_context(context, window)
            total = sum(context)
            pct = total / window * 100 if window else 0.0
            if total > peak_tokens:
                peak_tokens = total
                peak_percent = pct

            # Skip triggers immediately after another assistant message
            # (retry/resume/final-answer edge cases with no new user/tool input).
            if (
                prev_role != "assistant"
                and len(context) >= min_messages
                and step_counter - last_step >= 2
                and (pct >= threshold or step_counter - last_step >= step_interval)
            ):
                triggers.append(
                    {
                        "step": step_counter,
                        "message_index": idx,
                        "input_tokens": int(total),
                        "input_percent": round(pct, 1),
                        "reason": "token" if pct >= threshold else "step",
                    }
                )
                last_step = step_counter
                if trim:
                    context = context[-keep:]
                else:
                    context.append(float(summary_tokens))
                    _trim_context(context, window)
            context.append(tokens)
        else:
            context.append(tokens)

        _trim_context(context, window)
        prev_role = role

    return {
        "triggers": triggers,
        "peak_tokens": int(peak_tokens),
        "peak_percent": round(peak_percent, 1),
    }


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    k = (len(values) - 1) * p / 100.0
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return values[int(k)]
    return values[f] * (c - k) + values[c] * (k - f)


def clamp(n: int, low: int, high: int) -> int:
    return max(low, min(high, n))


def build_recommendations(
    sessions: list[dict[str, Any]], current: dict[str, Any]
) -> dict[str, Any]:
    long = [s for s in sessions if s.get("is_long")]
    if not long:
        long = sessions

    rec = dict(current)

    # Token threshold: set a safety net just below the 95th percentile of peak usage.
    # If sessions never approach the window, fall back to the default 55.
    peak_percents = [s["peak_percent"] for s in long]
    p95_peak = percentile(peak_percents, 95)
    if p95_peak >= 50:
        rec["tokenThresholdPercent"] = clamp(int(p95_peak * 0.85), 45, 80)
    else:
        rec["tokenThresholdPercent"] = 55 if current["tokenThresholdPercent"] > 55 else current["tokenThresholdPercent"]

    # stepInterval: base on median assistant-turn count in long sessions.
    assistant_steps = [s["assistant_count"] for s in long if s["assistant_count"]]
    if assistant_steps:
        med_steps = median(assistant_steps)
        rec["stepInterval"] = clamp(int(med_steps / 4), 5, 40)
    else:
        rec["stepInterval"] = current["stepInterval"]

    # keptRecentMessages: cover most user-task chunks.
    all_chunks: list[int] = []
    for s in long:
        all_chunks.extend(s.get("user_chunk_sizes", []))
    if all_chunks:
        p90_chunk = percentile(all_chunks, 90)
        rec["keptRecentMessages"] = clamp(int(p90_chunk) + 2, 4, 32)
    else:
        rec["keptRecentMessages"] = current["keptRecentMessages"]

    # maxSummaryTokens: scale with median trigger input size, but keep summaries compact.
    trigger_inputs: list[float] = []
    for s in long:
        for t in s.get("triggers", []):
            trigger_inputs.append(t["input_tokens"])
    if trigger_inputs:
        med_input = median(trigger_inputs)
        rec["maxSummaryTokens"] = clamp(int(med_input / 5 / 100) * 100, 1000, 3000)
    else:
        rec["maxSummaryTokens"] = current["maxSummaryTokens"]

    # trimAfterCompress: useful when sessions are long and tool results dominate tokens.
    tool_shares = [s["tool_result_token_share"] for s in long]
    long_count = len(long)
    avg_tool_share = sum(tool_shares) / len(tool_shares) if tool_shares else 0.0
    rec["trimAfterCompress"] = bool(long_count >= 5 and avg_tool_share > 40.0)

    # minMessagesToSummarize: keep default unless sessions trigger very early.
    first_trigger_steps = [t["step"] for s in long for t in s.get("triggers", [])[:1]]
    if first_trigger_steps and min(first_trigger_steps) <= 4:
        rec["minMessagesToSummarize"] = 4
    else:
        rec["minMessagesToSummarize"] = current["minMessagesToSummarize"]

    # Prompt hint: if recommended summary budget is tight, minimal may fit better.
    rec["promptName"] = "minimal" if rec["maxSummaryTokens"] <= 1200 else current["promptName"]

    return rec


def print_report(sessions: list[dict[str, Any]], current: dict[str, Any], rec: dict[str, Any]):
    long = [s for s in sessions if s.get("is_long")]
    print("=" * 70)
    print("Pi Session Compressor Tuner")
    print("=" * 70)
    print(f"Sessions analyzed: {len(sessions)} (long: {len(long)})")
    print(f"Token estimate: chars × {TOKENS_PER_CHAR} (rough; excludes system prompt)")
    print()

    print("Current context-compressor settings:")
    for key, value in current.items():
        print(f"  {key}: {value}")
    print()

    if sessions:
        durations = [s["duration_minutes"] for s in sessions if s["duration_minutes"]]
        msg_counts = [s["message_count"] for s in sessions]
        assistant_counts = [s["assistant_count"] for s in sessions]
        peak_percents = [s["peak_percent"] for s in sessions]
        print("Aggregate stats (all sessions):")
        print(f"  messages:  median={median(msg_counts):.0f}  p75={percentile(msg_counts, 75):.0f}  max={max(msg_counts)}")
        print(f"  assistant turns: median={median(assistant_counts):.0f}  p75={percentile(assistant_counts, 75):.0f}")
        if durations:
            print(f"  duration:  median={median(durations):.1f}m  p75={percentile(durations, 75):.1f}m")
        print(f"  est. peak usage: median={median(peak_percents):.1f}%  p75={percentile(peak_percents, 75):.1f}%  p95={percentile(peak_percents, 95):.1f}%")
        print()

    if long:
        trigger_counts = [len(s["triggers"]) for s in long]
        trigger_reasons: Counter[str] = Counter()
        for s in long:
            for t in s["triggers"]:
                trigger_reasons[t["reason"]] += 1
        print(f"Simulated triggers under current settings (long sessions):")
        print(f"  total={sum(trigger_counts)}  median/session={median(trigger_counts):.1f}  max/session={max(trigger_counts)}")
        print(f"  token-driven={trigger_reasons.get('token', 0)}  step-driven={trigger_reasons.get('step', 0)}")
        tool_shares = [s["tool_result_token_share"] for s in long]
        if tool_shares:
            print(f"  tool-result token share: avg={sum(tool_shares)/len(tool_shares):.1f}%  p75={percentile(tool_shares, 75):.1f}%")
        print()

    # Tool usage across long sessions.
    if long:
        all_tools: Counter[str] = Counter()
        for s in long:
            all_tools.update(s.get("tool_calls", {}))
        if all_tools:
            print("Top tools in long sessions:")
            for name, count in all_tools.most_common(10):
                print(f"  {name}: {count}")
            print()

    print("Recommended settings:")
    for key, value in rec.items():
        changed = ""
        if value != current.get(key):
            changed = f"  (was {current.get(key)})"
        print(f"  {key}: {value}{changed}")
    print()

    print("Per-session summary:")
    print(
        f"{'name':<50} {'msgs':>5} {'ast':>4} {'tool':>4} {'peak%':>6} {'trig':>4} {'model':<20}"
    )
    print("-" * 100)
    for s in sessions[:30]:
        model = (s.get("model_id") or "?")[:19]
        print(
            f"{s['name'][:49]:<50} {s['message_count']:>5} {s['assistant_count']:>4} "
            f"{s['tool_result_count']:>4} {s['peak_percent']:>6.1f} {len(s['triggers']):>4} {model:<20}"
        )
    if len(sessions) > 30:
        print(f"  ... and {len(sessions) - 30} more sessions")
    print("=" * 70)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    args = parse_args()
    current_settings = load_current_settings()

    sessions: list[dict[str, Any]] = []
    for path in iter_sessions(args.recent):
        result = analyze_session(path, args, current_settings)
        if result:
            sessions.append(result)

    if not sessions:
        print("No sessions matched the filters.", file=sys.stderr)
        sys.exit(1)

    sessions.sort(key=lambda s: s["message_count"], reverse=True)
    recommendations = build_recommendations(sessions, current_settings)

    if args.json:
        print(
            json.dumps(
                {
                    "current_settings": current_settings,
                    "recommended_settings": recommendations,
                    "sessions": sessions,
                },
                ensure_ascii=False,
                indent=2,
                default=str,
            )
        )
    else:
        print_report(sessions, current_settings, recommendations)


if __name__ == "__main__":
    main()
