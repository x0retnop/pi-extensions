# pi-multi-edit

Replaces the built-in `edit` tool with a batch-capable version.

## What it does

- **Single edit** — classic `path` + `oldText` + `newText`, fully backward-compatible.
- **Batch (`multi`)** — apply many edits across one or more files in a single tool call.
- **Patch mode** — Codex-style `*** Begin Patch … *** End Patch` payloads with `Add File`, `Delete File`, and `Update File` operations.

All mutations run a **preflight pass** on an in-memory snapshot first. If any replacement fails, no real file is touched. Both batch and patch modes are **fully atomic**: if any edit or patch operation fails during real execution, all changes are rolled back automatically.

## Install

```bash
pi install ./pi-multi-edit
```

Or copy the folder into your Pi extensions directory and `/reload`.

## Parameters

| Param | Type | Description |
|-------|------|-------------|
| `path` | `string?` | Target file, or default for `multi` items |
| `oldText` | `string?` | Exact text to replace |
| `newText` | `string?` | Replacement text |
| `multi` | `array?` | List of `{ path?, oldText, newText }` |
| `patch` | `string?` | Codex-style patch (mutually exclusive with the rest) |

## Examples

Single:
```json
{ "path": "src/index.ts", "oldText": "const foo = 1;", "newText": "const foo = 2;" }
```

Batch:
```json
{
  "path": "src/utils.ts",
  "multi": [
    { "oldText": "import a from 'a';", "newText": "import a from '@scope/a';" },
    { "path": "src/other.ts", "oldText": "const x = 0;", "newText": "const x = 42;" }
  ]
}
```

Patch:
```text
*** Begin Patch
*** Update File: src/main.ts
@@ function old() {
-function old() {
+function renamed() {
*** End Patch
```

## Notes

- Same-file edits are auto-sorted top-to-bottom so positional matching works regardless of the order the model lists them.
- Curly quotes and trailing-whitespace mismatches are retried with tolerant passes before failing.
- Duplicate `oldText → newText` pairs in the same file are skipped gracefully instead of erroring.
