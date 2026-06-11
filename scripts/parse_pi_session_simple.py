#!/usr/bin/env python3
"""
Parse Pi CLI session .jsonl into a plain chat transcript (Markdown).

Only user and assistant text messages — no thinking, no tool calls, no tool results.
Output looks like a copy-paste from a web chat.

Usage:
    python parse_pi_session_simple.py <session.jsonl> [output.md]
"""
import json
import sys
from datetime import datetime
from pathlib import Path


def fmt_ts(ts) -> str:
    try:
        if isinstance(ts, (int, float)):
            dt = datetime.fromtimestamp(ts / 1000.0)
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        if isinstance(ts, str):
            if ts.isdigit():
                dt = datetime.fromtimestamp(int(ts) / 1000.0)
                return dt.strftime("%Y-%m-%d %H:%M:%S")
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        pass
    return str(ts) if ts is not None else ""


def extract_text(content_list) -> str:
    """Pull only text blocks, skip thinking/toolCall/toolResult."""
    if not isinstance(content_list, list):
        return str(content_list) if content_list else ""
    parts = []
    for block in content_list:
        if isinstance(block, dict) and block.get("type") == "text":
            txt = block.get("text", "")
            if txt:
                parts.append(txt)
    return "\n\n".join(parts)


def main():
    if len(sys.argv) < 2:
        print("Usage: python parse_pi_session_simple.py <session.jsonl> [output.md]")
        sys.exit(1)

    in_path = Path(sys.argv[1]).expanduser().resolve()
    if not in_path.exists():
        print(f"Error: file not found: {in_path}")
        sys.exit(1)

    out_path = Path(sys.argv[2]).expanduser().resolve() if len(sys.argv) >= 3 else in_path.with_suffix(".md")

    user_count = 0
    assistant_count = 0
    lines = []

    with open(in_path, "r", encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if obj.get("type") != "message":
                continue

            msg = obj.get("message", {})
            role = msg.get("role", "")
            if role not in ("user", "assistant"):
                continue

            ts = msg.get("timestamp") or obj.get("timestamp", "")
            text = extract_text(msg.get("content", []))
            if not text.strip():
                continue

            ts_str = fmt_ts(ts)
            if role == "user":
                user_count += 1
                lines.append(f"**User**  ")
                if ts_str:
                    lines.append(f"*{ts_str}*")
                lines.append("")
                lines.append(text)
            else:
                assistant_count += 1
                lines.append(f"**Assistant**  ")
                if ts_str:
                    lines.append(f"*{ts_str}*")
                lines.append("")
                lines.append(text)

            lines.append("")
            lines.append("---")
            lines.append("")

    # Remove trailing separator
    while lines and lines[-1] in ("", "---"):
        lines.pop()

    header = f"# Chat Transcript\n\n"
    header += f"*Source:* `{in_path.name}`\n\n"

    out_path.write_text(header + "\n".join(lines), encoding="utf-8")
    print(f"Written: {out_path}")
    print(f"Messages: {user_count} user, {assistant_count} assistant")


if __name__ == "__main__":
    main()
