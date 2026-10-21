# context-trim

Manual **one-shot** superseded full-read trim (`/trim`). No auto, no background mode.

## Commands

| Command | Effect |
|---|---|
| `/trim preview` | Estimate only |
| `/trim` | Compute stubs **now** and freeze them for LLM context |
| `/trim clear` | Drop stubs (full reads again) |
| `/trim status` | Active stub count + what a re-run would do |
| `/trim min N` | Size threshold for the next `/trim` (default 2000) |

## What `/trim` does

1. Scans current session messages for full-file `read` results (raw, no offset/limit/section).
2. Per path keeps the **last** success; earlier large ones become a fixed one-line stub.
3. Stores a map `toolCallId → stub` in the session (`context-trim-state`).
4. On every later LLM call, only those frozen ids are replaced (no re-discovery).

Session `.jsonl` is **not** rewritten (TUI / export stay full).

## Typical use

```
/resume …          # or after a long idle cold start
/trim preview      # optional
/trim              # apply once
… work …
/trim clear        # optional, if you want full dumps back
```

## Deploy

Copy to `~/.pi/agent/extensions/context-trim/` and restart Pi.
