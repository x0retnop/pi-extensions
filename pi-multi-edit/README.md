# pi-multi-edit

Batch-capable replacement for the built-in `edit` tool.

## Features

- **Single edit** — classic `path` + `oldText` + `newText`, fully backward-compatible.
- **Single-file batch (`edits`)** — many edits to one file via a top-level `path`.
- **Multi-file batch (`multi`)** — edits across one or more files in a single tool call.
- **Atomic** — preflight pass on an in-memory snapshot first. If any replacement fails, no real file is touched. Failed real execution rolls back all changes automatically.
- **Tolerant matching** — retries with curly-quote, trailing-whitespace, and indentation (tabs ↔ spaces) normalization before failing.
- **Duplicate safety** — duplicate `oldText → newText` pairs in the same file are skipped gracefully.
- **Auto-sort** — same-file edits are sorted top-to-bottom so positional matching works regardless of model ordering.

## Tradeoff

Replaces the native `edit` renderer. In the TUI, multi-file calls render in a compact custom block instead of the native diff view. The functionality is fully intact; only the visual presentation differs.

## Install

```bash
pi install ./pi-multi-edit
```

## Parameters

| Param | Type | Description |
|-------|------|-------------|
| `path` | `string?` | Target file for classic mode or `edits` batch |
| `oldText` | `string?` | Exact text to replace (classic mode) |
| `newText` | `string?` | Replacement text (classic mode) |
| `edits` | `array?` | Batch edits `{ oldText, newText }` within a single file (requires top-level `path`) |
| `multi` | `array?` | Multi-file edits `{ path, oldText, newText }` (each item needs its own `path`) |

## Examples

Single:
```json
{ "path": "src/index.ts", "oldText": "const foo = 1;", "newText": "const foo = 2;" }
```

Single-file batch:
```json
{
  "path": "src/utils.ts",
  "edits": [
    { "oldText": "import a from 'a';", "newText": "import a from '@scope/a';" },
    { "oldText": "const x = 0;", "newText": "const x = 42;" }
  ]
}
```

Multi-file batch:
```json
{
  "multi": [
    { "path": "src/utils.ts", "oldText": "import a from 'a';", "newText": "import a from '@scope/a';" },
    { "path": "src/other.ts", "oldText": "const x = 0;", "newText": "const x = 42;" }
  ]
}
```
