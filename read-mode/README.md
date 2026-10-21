# read-mode

Mode-based replacement for the built-in `read` tool. Targets agent workflows: structured navigation instead of blind full-file reads.

## Features

- **overview** — Returns a structure map (functions, classes, headers) with line ranges. Use first for unfamiliar files >200 lines.
- **section** — Reads a specific function, class, or header by exact or fuzzy name match. **Detects block boundaries** (Python indentation, JS/TS braces) and returns the full block when it fits within `limit`. If the block is larger, it truncates and reports the total block length so the agent can continue. Default `limit` is 120; use 250-300 for long Python signatures or classes.
- **raw (default)** — Full file read with `offset`/`limit`. Supports images (PNG, JPG, GIF, WebP, BMP). **Does not accept `target`** — the tool auto-switches to `section` if a target is passed, but agents should use `mode:section` explicitly.

## Why it works better

- **Smart block detection** — `mode:section` understands where a Python function or JS class ends, instead of returning a fixed line count that often cuts the block in half. Markdown/HTML sections run until the next heading of the same or higher level.
- **Auto-correct safety net** — If an agent accidentally passes `target` in `raw` mode, the tool automatically switches to `section` instead of silently returning the entire file.
- **Explicit continuation hints** — When a block is truncated, the output tells the agent how many lines the full block has and what offset to use for `mode:raw` to continue.
- **Fewer tokens, less noise, fewer round-trips.**

## Install

```bash
pi install ./read-mode
```

## Parameters

| Param | Type | Description |
|-------|------|-------------|
| `path` | `string` | File to read (relative or absolute) |
| `mode` | `string?` | `overview`, `section`, or `raw` (default) |
| `target` | `string?` | Name for `section`. **Do not use with `raw`.** |
| `limit` | `number?` | Max lines. For `section`: soft limit — full block returned if it fits. Default 120. For `raw`: hard line limit from offset. |
| `offset` | `number?` | Start line for `raw` (1-indexed) |

## Examples

```json
{ "mode": "overview", "path": "src/app.ts" }
{ "mode": "section", "path": "src/app.ts", "target": "handleRequest" }
{ "mode": "section", "path": "app.py", "target": "process_data", "limit": 120 }
{ "mode": "section", "path": "app.py", "target": "process_data", "limit": 250 }
{ "mode": "raw", "path": "src/app.ts", "offset": 1000, "limit": 500 }
{ "path": "screenshot.png" }
```

## Notes

- `overview` is cached by file mtime; repeated calls on unchanged files are instant.
- `section` fuzzy match tolerates prefixes: `authenticate` matches `async authenticate` and `private authenticate`.
- Python: recognizes `async def`; `section` includes leading `@decorators`.
- JS/TS: `export default function` (anon → name `default`); top-level/`export` `const fn = () =>`; nested const helpers omitted.
- Rust: `pub(crate)`, `async fn`, `mod`, `impl Trait for Type`.
- Markdown: ATX headings; fences ignored as structure; `{#id}` / `[text](url)` names are cleaned.
- HTML: same-line `<h1>`–`<h6>` only (text, or `id` if empty). Not a DOM parser.
- For project-wide search use the separate `grep` tool, not this read tool.
- Image files must use `mode:raw` (or omit mode) so the model receives the actual image bytes.
- When `section` cannot detect the block end (unsupported language or unusual syntax), it falls back to the `limit` line cap and adds a warning to the output.
- `overview` and `section` are structure-based: they only produce output for files with named entities (functions, classes, headings). Plain scripts, configs, logs, data, and plain-text files return `No recognizable structure found` (overview) or `Section "..." not found` — read those with `raw`.
