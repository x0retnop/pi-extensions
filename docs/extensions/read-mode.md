# read-mode

Mode-aware override of the built-in `read` tool.

## What it does

Provides structured ways to read files without loading everything into context at once.

## Tool

- `read` — replaces the built-in read tool.
  - `mode: "overview"` — list top-level structure (functions/classes/headers) with line numbers.
  - `mode: "section"` — read a specific block by name.
  - `mode: "grep"` — search inside one file.
  - `mode: "headtail"` — first + last N lines.
  - `mode: "raw"` (default) — plain read with optional `offset`/`limit`.

## Important behaviors

- Supports images (PNG, JPG, GIF, WebP, BMP) in raw mode.
- If `mode: "raw"` is used with a `target`, it auto-switches to `mode: "section"`.
- Block detection works for JS/TS braces and Python indentation.
- Output is truncated to `maxBytes` (default 65536) with continuation hints.

## Source

- `read-mode/index.ts` — tool registration.
- `read-mode/parser.ts` — overview/section/grep/headtail logic.
