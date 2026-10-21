# stream-tool-log

Operator toggles only (`/streamlog on|off`). You read `INDEX.json` + `diag` rows. Do not ask them for verbose/flush/note.

## Non-obvious

- Session JSONL has **final** assistant messages only. This logger is the live `toolcall_*` timeline.
- Verdicts are **written into the log**. Do not re-classify. `diag.verdict` wins.
- One JSONL per session (`<sessionStem>.jsonl`). Resume appends. New session → new file.
- Off by default. `settings.json` → `streamToolLog.enabled`. Footer `stl` only when on.
- v1 logs (before this rewrite) have no `diag`. The report script still summarizes them.

## Where

```
~/.pi/agent/logs/stream-tool/
  INDEX.json
  AGENT.md              (same cheat-sheet, written next to the data)
  <sessionStem>.jsonl
```

Read `INDEX.json` first: `current`, `last` (latest diag), `verdicts` counts. If that answers the blame, stop. Else `rg '"ev":"diag"' <current>`.

`INDEX.last` fields: `sid`, `verdict`, `provider`, `model`, `silenceMs`, `ui`.

## `diag` row

One per assistant stream that has write/edit/multi_edit/insert **or** silence ≥ 3s.

| field | meaning |
|---|---|
| `verdict` | `provider_buffer` \| `progressive` \| `mixed` \| `none` |
| `silenceMs` | ms before first toolCall. `>=3000` → blank screen (thinking; Working often hidden) |
| `thinkChars` / `textChars` | visible thinking/text. Tiny think + long silence = encrypted reasoning |
| `ui` | `blank` \| `ellipsis` (`write ...`) \| `full_pop` \| `grow` |
| `mut[]` | mut tools only |

### `mut[]`

| field | meaning |
|---|---|
| `verdict` | `provider_buffer` \| `progressive` \| `header_late` \| `unknown` |
| `d` | `toolcall_delta` count. `1` + large bytes = dump |
| `pathAt` / `contentAt` / `oldAt` / `newAt` | ms from that tool's start until field non-empty |
| `emptyMs` | ms of `write ...` / `edit ...` (path empty) |
| `how` | one-line reason |

## Blame

| verdict | who | matches |
|---|---|---|
| `provider_buffer` | provider dumped args | nothing, then the full file |
| `progressive` | args grow (many Δ). Late path + many Δ = JSON key order (`new_string` first), not a dump | growing sizes; `edit ...` until path |
| `header_late` | path arrived at end / never, **few** Δ | `write ...` the whole generation |
| long `silenceMs` + tiny `thinkChars` | encrypted thinking, no chrome | emptiness before any tool |

Typical: Kimi / DeepSeek → `progressive`. xAI Grok `openai-responses` → `provider_buffer`.

## Other `ev`

`open` `mode` `stream` `mark` `exec` `pack` `shut` — timeline only. You rarely need them.

Schema `v: 2`. v1 used `tc_start` / `tc_milestone` / `tc_end` / `summary`.

## Report

```bash
python scripts/stream_tool_log_report.py           # INDEX current
python scripts/stream_tool_log_report.py --recent 3
python scripts/stream_tool_log_report.py --json
python scripts/stream_tool_log_report.py path.jsonl
```

Prints `diag` rows. v1 files fall back to the old summary.

## Interactions

None. File JSONL only — no tools, no prompt, no `appendEntry`.
