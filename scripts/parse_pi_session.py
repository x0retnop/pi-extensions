#!/usr/bin/env python3
"""
Parse Pi CLI session .jsonl files into structured Markdown.

Usage:
    python parse_pi_session.py <session.jsonl> [output.md]

If output is omitted, writes to <session>.md alongside the input file.
"""
import json
import sys
import os
import re
from datetime import datetime
from pathlib import Path


def iso_to_local(ts) -> str:
    """Pretty-print ISO timestamp or unix ms."""
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


def format_tool_calls(blocks):
    """Render toolCall blocks as markdown."""
    lines = []
    for b in blocks:
        if b.get("type") != "toolCall":
            continue
        name = b.get("name", "unknown")
        tid = b.get("id", "")
        args = b.get("arguments", {})
        lines.append(f"- **Tool**: `{name}`  ")
        if tid:
            lines.append(f"  **ID**: `{tid}`")
        if args:
            try:
                args_json = json.dumps(args, ensure_ascii=False, indent=2)
                lines.append(f"  **Arguments**:")
                lines.append("  ```json")
                for ln in args_json.splitlines():
                    lines.append(f"  {ln}")
                lines.append("  ```")
            except Exception:
                lines.append(f"  **Arguments**: {args}")
    return "\n".join(lines) if lines else ""


def format_content_blocks(content_list, role):
    """Convert a message content array to markdown string."""
    if not isinstance(content_list, list):
        return str(content_list) if content_list else ""

    text_parts = []
    thinking_parts = []
    tool_call_parts = []

    for block in content_list:
        btype = block.get("type")
        if btype == "text":
            text_parts.append(block.get("text", ""))
        elif btype == "thinking":
            thinking_parts.append(block.get("thinking", ""))
        elif btype == "toolCall":
            tool_call_parts.append(block)

    md_blocks = []

    # Thinking (collapsible)
    if thinking_parts:
        combined_think = "\n\n".join(thinking_parts)
        md_blocks.append(
            f"<details>\n<summary>Thinking</summary>\n\n```text\n{combined_think}\n```\n\n</details>"
        )

    # Tool calls
    if tool_call_parts:
        md_blocks.append("**Tool Calls:**\n")
        md_blocks.append(format_tool_calls(tool_call_parts))

    # Main text
    if text_parts:
        combined_text = "\n\n".join(text_parts).strip()
        if combined_text:
            md_blocks.append(combined_text)

    return "\n\n".join(md_blocks)


def parse_jsonl(path: Path):
    """Parse Pi session JSONL into structured data."""
    session_info = {}
    messages = []
    broken_lines = 0

    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                broken_lines += 1
                continue

            etype = obj.get("type")
            if etype == "session":
                session_info = {
                    "id": obj.get("id", ""),
                    "timestamp": obj.get("timestamp", ""),
                    "cwd": obj.get("cwd", ""),
                    "version": obj.get("version", ""),
                }
            elif etype == "message":
                msg = obj.get("message", {})
                role = msg.get("role", "unknown")
                ts = msg.get("timestamp") or obj.get("timestamp", "")
                content = msg.get("content", [])
                # Tool results sometimes live as separate message role=toolResult
                if role == "toolResult":
                    tool_name = msg.get("toolName", "unknown")
                    tool_call_id = msg.get("toolCallId", "")
                    is_error = msg.get("isError", False)
                    # content may be list of {type:"text", text:"..."}
                    result_texts = []
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text":
                            result_texts.append(c.get("text", ""))
                        elif isinstance(c, str):
                            result_texts.append(c)
                    messages.append({
                        "role": "tool",
                        "timestamp": ts,
                        "tool_name": tool_name,
                        "tool_call_id": tool_call_id,
                        "is_error": is_error,
                        "text": "\n".join(result_texts),
                    })
                else:
                    messages.append({
                        "role": role,
                        "timestamp": ts,
                        "content": content,
                    })

    return session_info, messages, broken_lines


def build_markdown(session_info, messages, broken_lines):
    """Build markdown document."""
    lines = []
    sid = session_info.get("id", "")
    sts = session_info.get("timestamp", "")
    cwd = session_info.get("cwd", "")
    ver = session_info.get("version", "")

    lines.append(f"# Pi Session — {iso_to_local(sts) if sts else 'unknown'}")
    if sid:
        lines.append(f"- **Session ID**: `{sid}`")
    if cwd:
        lines.append(f"- **CWD**: `{cwd}`")
    if ver:
        lines.append(f"- **Format Version**: {ver}")
    if broken_lines:
        lines.append(f"- ⚠️ **Skipped broken lines**: {broken_lines}")
    lines.append("")

    for i, m in enumerate(messages, 1):
        role = m["role"]
        ts = m.get("timestamp", "")
        ts_str = iso_to_local(ts) if ts else ""

        if role == "user":
            lines.append(f"## {i}. 👤 User")
            if ts_str:
                lines.append(f"*{ts_str}*")
            body = format_content_blocks(m.get("content", []), role)
            lines.append(body)

        elif role == "assistant":
            lines.append(f"## {i}. 🤖 Assistant")
            if ts_str:
                lines.append(f"*{ts_str}*")
            body = format_content_blocks(m.get("content", []), role)
            lines.append(body)

        elif role == "tool":
            lines.append(f"## {i}. 🛠️ Tool Result — `{m['tool_name']}`")
            if m.get("tool_call_id"):
                lines.append(f"- **Call ID**: `{m['tool_call_id']}`")
            if m.get("is_error"):
                lines.append("- **Status**: ❌ Error")
            else:
                lines.append("- **Status**: ✅ Success")
            lines.append("")
            txt = m.get("text", "").strip()
            if txt:
                # If it looks like JSON, wrap in json block, else text
                try:
                    json.loads(txt)
                    lines.append(f"```json\n{txt}\n```")
                except Exception:
                    lines.append(f"```text\n{txt}\n```")
            else:
                lines.append("*(empty result)*")

        else:
            lines.append(f"## {i}. ❓ Unknown role: `{role}`")
            lines.append(str(m))

        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print("Usage: python parse_pi_session.py <session.jsonl> [output.md]")
        sys.exit(1)

    in_path = Path(sys.argv[1]).expanduser().resolve()
    if not in_path.exists():
        print(f"Error: file not found: {in_path}")
        sys.exit(1)

    if len(sys.argv) >= 3:
        out_path = Path(sys.argv[2]).expanduser().resolve()
    else:
        out_path = in_path.with_suffix(".md")

    print(f"Parsing: {in_path}")
    session_info, messages, broken_lines = parse_jsonl(in_path)
    md = build_markdown(session_info, messages, broken_lines)

    out_path.write_text(md, encoding="utf-8")
    print(f"Written: {out_path}")
    print(f"Messages: {len(messages)} (skipped broken JSON lines: {broken_lines})")


if __name__ == "__main__":
    main()
