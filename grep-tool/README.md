# grep-tool

Structured project-wide search via ripgrep. Tuned for agent use: safe defaults, multiple output modes, and Windows path fallback.

## Features

- **Structured output** — Uses `rg --json` for reliable parsing instead of raw shell text.
- **Output modes** — `content` (with context), `files_with_matches` (paths only), `count_matches` (totals).
- **Safe limits** — `head_limit` caps results to avoid flooding the context window.
- **Path sandboxing** — rejects search paths that would escape the project directory.
- **Filters** — glob, file type, case-insensitive, multiline, whole-word, context lines.
- **Respects `.gitignore`** — no accidental node_modules dumps.
- **Windows fallback** — checks common install paths if `rg` is not on `PATH`.

## Install

```bash
pi install ./grep-tool
```

## Parameters

| Param | Type | Description |
|-------|------|-------------|
| `pattern` | `string` | Regex or literal search pattern |
| `path` | `string?` | File or directory to search (default: cwd) |
| `output_mode` | `string?` | `content`, `files_with_matches`, or `count_matches` |
| `head_limit` | `number?` | Max matches to return |
| `glob` | `string?` | File name filter, e.g. `*.ts` |
| `type` | `string?` | File type filter, e.g. `ts` |
| `-i` | `boolean?` | Case-insensitive |
| `fixed_strings` | `boolean?` | Literal string match (`rg -F`) |
| `word_match` | `boolean?` | Whole-word match (`rg -w`) |
| `multiline` | `boolean?` | Multiline matching |
| `-C` | `number?` | Context lines around each match |
| `include_ignored` | `boolean?` | Search files ignored by `.gitignore` |
| `allow_broad` | `boolean?` | Skip the broad-query guard (use with care) |

## Examples

```json
{ "pattern": "TODO", "output_mode": "files_with_matches" }
{ "pattern": "function foo(", "fixed_strings": true, "glob": "*.ts" }
{ "pattern": "class\\s+User", "type": "ts", "output_mode": "content", "-C": 2 }
```

## Broad-query guard

In `content` mode the tool runs a quick preflight count. If the pattern matches more than ~100 lines (or ~50 lines when context is requested), it refuses the dump and tells you how to narrow it:

- Use `output_mode: "files_with_matches"` to see which files contain the pattern.
- Use `output_mode: "count_matches"` to measure scope before diving in.
- Add `glob`, `type`, `word_match`, or a narrower `path`.
- Set `allow_broad: true` only if you really need the full dump.

## Requirements

`rg` (ripgrep) must be installed. On Windows, if it is not on `PATH`, the tool falls back to `C:\ProgramData\chocolatey\bin\rg.exe` and other common locations before failing.
