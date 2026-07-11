# grep-tool

Project-wide `grep` tool override powered by ripgrep.

## What it does

- Replaces the built-in `grep` tool with a ripgrep-based implementation.
- Supports regex and literal search, file-type filters, context lines, and output modes.
- Has a preflight guard against overly broad content queries.

## Tool

- `grep` — search across files.
  - `pattern` is a regex by default. Use `fixed_strings: true` for literal text.
  - `output_mode`: `content` (default), `files_with_matches`, `count_matches` (total plus per-file breakdown, top files first).
  - `path`, `glob`, `type`, `-i`, `-C`, `-B`, `-A`, `head_limit`, `include_ignored`, `allow_broad`.

## Important behaviors

- Requires `rg` (ripgrep) in `PATH`.
- Respects `.gitignore` by default. Use `include_ignored: true` to search ignored files (`.env` still excluded).
- Git Bash `/c/...` paths are normalized to Windows drive letters.
- Broad queries return a hint instead of a wall of text unless `allow_broad: true`.

## Source

- `grep-tool/index.ts`
