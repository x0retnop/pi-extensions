# pi-multi-edit

Agent-first file editing tools optimized for Kimi K2.x models.

## What it does

Replaces Pi's built-in `edit` tool and adds separate `multi_edit` and `insert` tools. The shapes are chosen to match the `strreplace` / `createfile` / `insert` vocabulary Kimi K2.6/K2.7 Code was trained on, while still supporting batch edits when they are genuinely useful.

## Tools

### `edit`

Single exact-text replacement in one file.

```json
{
  "path": "src/app.py",
  "old_string": "foo",
  "new_string": "bar",
  "replace_all": false
}
```

- `old_string` must match exactly including indentation, tabs, quotes, and trailing whitespace.
- If `old_string` appears more than once and `replace_all` is not set, the call fails.
- Set `new_string` to `""` to delete the matched block.

### `multi_edit`

Multiple sequential replacements in one file.

```json
{
  "path": "src/app.py",
  "edits": [
    { "old_string": "foo", "new_string": "bar" },
    { "old_string": "baz", "new_string": "qux" }
  ]
}
```

- Edits are applied sequentially: `edits[1]` sees the file after `edits[0]`.
- Partial apply: if some edits fail, the successful ones are still written and each failure is reported with a hint.
- Each `old_string` must be unique in the current file state unless `replace_all` is true for that item.

### `insert`

Insert one or more lines before a specific line number.

```json
{
  "path": "src/app.py",
  "insert_line": 42,
  "new_string": "    new_line();"
}
```

- `insert_line` is 1-indexed. Use `1` to prepend, `line_count + 1` to append.
- For replacing existing text, use `edit` instead.

## Why three tools?

Modern coding models (Kimi K2.x, Claude) were trained on simple single `str_replace` operations. A complex batch schema inside the primary `edit` tool creates a mismatch: the model tends to under-use batches and falls back to many single edits, re-reading the file each time.

By separating `edit` (single) from `multi_edit` (batch), the model gets:

- A simple, familiar tool for the common case.
- An explicit, well-defined tool for multiple independent replacements.
- Clear guidance on when to use each.

The `insert` tool matches the line-based insertion primitive from the same training vocabulary, avoiding awkward boundary overlap edits.

## Source

- `pi-multi-edit/index.ts` — tool registration and prompts.
- `pi-multi-edit/engine.ts` — matching, apply, and insert logic.
- `pi-multi-edit/params.ts` — input schemas and parsing.
- `pi-multi-edit/match.ts` — exact + fuzzy text matching.
- `pi-multi-edit/normalize.ts` — BOM, CRLF/LF, and fuzzy normalization.
- `pi-multi-edit/diff.ts` — change stats.
- `pi-multi-edit/messages.ts` — result formatting.
- `pi-multi-edit/render.ts` — TUI call/result rendering.
- `pi-multi-edit/workspace.ts` — real and virtual workspace wrappers.
- `pi-multi-edit/lock.ts` — per-path async lock serializing same-file edits.

## Behaviors

- Preflight pass runs on a virtual workspace before writing. If preflight fails, no file is modified.
- Same-file edits are serialized per absolute path (`lock.ts`). Parallel `edit`/`multi_edit`/`insert` calls to one file can no longer interleave their read-modify-write cycle — previously the later full-file write silently overwrote the earlier edit while both reported success. Edits to different files still run in parallel.
- BOM and line endings (CRLF/LF) are preserved.
- Fuzzy match is used as a fallback for whitespace/quote differences; the result reports success and flags the fuzzy match so the model can copy verbatim next time.
- Error messages include line-number hints when possible.
