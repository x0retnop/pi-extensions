#!/usr/bin/env python3
"""Extract error tool results with preceding assistant reasoning from a Pi session JSONL."""
import json
import sys
from pathlib import Path


def iter_messages(path: Path):
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def get_text(blocks, typ: str):
    if not isinstance(blocks, list):
        return ""
    out = []
    for b in blocks:
        if not isinstance(b, dict) or b.get("type") != typ:
            continue
        if "text" in b:
            out.append(b["text"])
        elif "thinking" in b:
            out.append(b["thinking"])
    return "\n".join(out)


def main():
    if len(sys.argv) < 2:
        print(f"usage: {sys.argv[0]} <session.jsonl> [--max-reasoning N] [--tool TOOL]", file=sys.stderr)
        sys.exit(1)
    path = Path(sys.argv[1])
    max_reasoning = 4000
    tool_filter = None
    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == "--max-reasoning" and i + 1 < len(args):
            max_reasoning = int(args[i + 1])
            i += 2
        elif args[i] == "--tool" and i + 1 < len(args):
            tool_filter = args[i + 1]
            i += 2
        else:
            i += 1

    messages = list(iter_messages(path))
    by_id = {m.get("id"): m for m in messages if m.get("id")}

    # Build child map: parent_id -> next message(s)
    children = {}
    for m in messages:
        pid = m.get("parentId")
        if pid:
            children.setdefault(pid, []).append(m)

    def find_tool_call_args(tool_result_id: str, tool_call_id: str):
        """Walk ancestors until the assistant message with the matching toolCall."""
        seen = set()
        cur = by_id.get(tool_result_id)
        while cur and cur.get("id") not in seen:
            seen.add(cur.get("id"))
            cur = by_id.get(cur.get("parentId"))
            if not cur:
                break
            cmsg = cur.get("message") or {}
            if cmsg.get("role") != "assistant":
                continue
            for c in cmsg.get("content") or []:
                if (
                    isinstance(c, dict)
                    and c.get("type") == "toolCall"
                    and c.get("id") == tool_call_id
                ):
                    return c.get("arguments", {})
        return {}

    errors = []
    for m in messages:
        msg = m.get("message") or {}
        if m.get("type") == "message" and msg.get("role") == "toolResult":
            content = msg.get("content") or []
            is_err = msg.get("isError") or any(
                isinstance(c, dict) and c.get("isError") for c in content
            )
            tool_name = msg.get("toolName") or "?"
            if tool_filter and tool_name != tool_filter:
                continue
            if not is_err:
                continue

            # Reasoning is usually in the assistant message that follows this result
            reasoning = ""
            for child in children.get(m.get("id"), []):
                cmsg = child.get("message") or {}
                if cmsg.get("role") == "assistant":
                    reasoning = get_text(cmsg.get("content") or [], "thinking")
                    if reasoning:
                        break

            # Tool call args come from the assistant message that emitted the call
            call_args = find_tool_call_args(m.get("id"), msg.get("toolCallId"))

            text_parts = []
            for c in content:
                if isinstance(c, dict) and "text" in c:
                    text_parts.append(c["text"])
            result_text = "\n".join(text_parts)
            errors.append({
                "idx": messages.index(m) + 1,
                "id": m.get("id"),
                "tool": tool_name,
                "toolCallId": msg.get("toolCallId"),
                "reasoning": reasoning[:max_reasoning],
                "call_args": call_args,
                "result_text": result_text[:max_reasoning],
            })

    print(f"# Errors in {path.name}\n")
    print(f"Total error tool results: {len(errors)}\n")
    for e in errors:
        print(f"---")
        print(f"## [{e['idx']}] tool={e['tool']} id={e['id']}")
        print(f"\n### Reasoning\n")
        print(e["reasoning"] or "(none)")
        print(f"\n### Tool call args\n")
        print(json.dumps(e["call_args"], ensure_ascii=False, indent=2))
        print(f"\n### Result\n")
        print(e["result_text"])
        print()


if __name__ == "__main__":
    main()
