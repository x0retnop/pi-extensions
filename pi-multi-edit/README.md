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

## Patch Format

Patches use Codex-style `*** Begin Patch ... *** End Patch` syntax.

### Rules

1. **`@@` context marker** — contains a line that appears **BEFORE** the change, not the line being changed.
2. **`-` lines** — exact lines removed from the file.
3. **`+` lines** — new lines inserted.
4. **` ` lines** (space prefix) — context kept unchanged (optional but recommended).
5. **Insertions with no removal** — use `@@` with context prefix, then only `+` lines.

### Examples

**Replace a line (context = line before):**
```text
*** Begin Patch
*** Update File: src/main.ts
@@ function setup() {
-    const x = 1;
+    const x = 2;
*** End Patch
```

**Insert after existing code (no old lines removed):**
```text
*** Begin Patch
*** Update File: src/main.ts
@@ function setup() {
+    const y = 3;
*** End Patch
```

**Multi-line replacement:**
```text
*** Begin Patch
*** Update File: src/main.ts
@@ function setup() {
-    const x = 1;
-    return x;
+    const x = 2;
+    return x + 1;
*** End Patch
```

**Multi-file patch (update + add):**
```text
*** Begin Patch
*** Update File: src/a.ts
@@ const foo = 1;
-const foo = 1;
+const foo = 2;
*** Update File: src/b.ts
@@ export
-const bar = 3;
+const bar = 4;
*** Add File: src/c.ts
+export const baz = 5;
*** End Patch
```

**Common mistake — WRONG:**
```text
@@ -    const x = 1;   <-- NEVER: @@ contains the line being changed
-    const x = 1;
+    const x = 2;
```

## Notes

- Same-file edits are auto-sorted top-to-bottom so positional matching works regardless of the order the model lists them.
- Curly quotes and trailing-whitespace mismatches are retried with tolerant passes before failing.
- Duplicate `oldText → newText` pairs in the same file are skipped gracefully instead of erroring.
- Both batch and patch modes are **fully atomic**: if any edit fails, all changes are rolled back automatically.
