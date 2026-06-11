# read-mode

Mode-based replacement for the built-in `read` tool. Targets agent workflows: structured navigation instead of blind full-file reads.

## Features

- **overview** — Returns a structure map (functions, classes, headers) with line ranges. Use first for unfamiliar files >200 lines.
- **section** — Reads a specific function, class, or header by exact or fuzzy name match. **Detects block boundaries** (Python indentation, JS/TS braces) and returns the full block when it fits within `limit`. If the block is larger, it truncates and reports the total block length so the agent can continue.
- **grep** — Searches inside a single file with configurable context lines. Supports literal (`fixed_strings`) and regex matching.
- **headtail** — First and last 20 lines. For logs and large config files.
- **raw (default)** — Full file read with `offset`/`limit`. Supports images (PNG, JPG, GIF, WebP, BMP). **Does not accept `target`** — the tool auto-switches to `section` if a target is passed, but agents should use `mode:section` explicitly.

## Why it works better

- **Smart block detection** — `mode:section` understands where a Python function or JS class ends, instead of returning a fixed line count that often cuts the block in half.
- **Auto-correct safety net** — If an agent accidentally passes `target` in `raw` mode, the tool automatically switches to `section` instead of silently returning the entire file.
- **Explicit continuation hints** — When a block is truncated, the output tells the agent exactly how many lines the full block has and what offset to use for `mode:raw` to continue.
- **Fewer tokens, less noise, fewer round-trips.**

## Install

```bash
pi install ./read-mode
```

## Parameters

| Param | Type | Description |
|-------|------|-------------|
| `path` | `string` | File to read (relative or absolute) |
| `mode` | `string?` | `overview`, `section`, `grep`, `headtail`, or `raw` (default) |
| `target` | `string?` | Name for `section`; pattern for `grep`. **Do not use with `raw`.** |
| `contextLines` | `number?` | Context around matches for `grep` (default 3) |
| `limit` | `number?` | Max lines. For `section`: soft limit — full block returned if it fits. For `raw`: hard line limit from offset. |
| `fixed_strings` | `boolean?` | Literal match for `grep` (default false) |
| `maxBytes` | `number?` | Byte ceiling for output (default 65536) |
| `offset` | `number?` | Start line for `raw` (1-indexed) |

## Examples

```json
{ "mode": "overview", "path": "src/app.ts" }
{ "mode": "section", "path": "src/app.ts", "target": "handleRequest" }
{ "mode": "section", "path": "app.py", "target": "process_data", "limit": 80 }
{ "mode": "grep", "path": "src/app.ts", "target": "validateToken", "contextLines": 2 }
{ "mode": "headtail", "path": "logs/app.log" }
{ "mode": "raw", "path": "src/app.ts", "offset": 1000, "limit": 300 }
{ "path": "screenshot.png" }
```

## Notes

- `overview` is cached by file mtime; repeated calls on unchanged files are instant.
- `section` fuzzy match tolerates prefixes: `authenticate` matches `async authenticate` and `private authenticate`.
- `grep` mode is single-file only. Use the separate `grep` tool for project-wide search.
- Image files must use `mode:raw` (or omit mode) so the model receives the actual image bytes.
- When `section` cannot detect the block end (unsupported language or unusual syntax), it falls back to the `limit` line cap and adds a warning to the output.
