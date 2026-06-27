# pi-multi-edit

Agent-first file editing tools optimized for Kimi K2.x models.

## What it does

Replaces Pi's built-in `edit` tool and adds a separate `multi_edit` tool. The shapes are chosen to match the `strreplace` / `createfile` vocabulary Kimi K2.6/K2.7 Code was trained on, while still supporting batch edits when they are genuinely useful.

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
- The whole batch is aborted if any edit fails (atomic).
- Each `old_string` must be unique in the current file state unless `replace_all` is true for that item.

## Why two tools?

Modern coding models (Kimi K2.x, Claude) were trained on simple single `str_replace` operations. A complex batch schema inside the primary `edit` tool creates a mismatch: the model tends to under-use batches and falls back to many single edits, re-reading the file each time.

By separating `edit` (single) from `multi_edit` (batch), the model gets:

- A simple, familiar tool for the common case.
- An explicit, well-defined tool for multiple independent replacements.
- Clear guidance on when to use each.

## Source

- `pi-multi-edit/index.ts` — tool registration and prompts.
- `pi-multi-edit/engine.ts` — matching and apply logic.
- `pi-multi-edit/params.ts` — input schemas and parsing.
- `pi-multi-edit/match.ts` — exact + fuzzy text matching.
- `pi-multi-edit/normalize.ts` — BOM, CRLF/LF, and fuzzy normalization.
- `pi-multi-edit/diff.ts` — change stats.
- `pi-multi-edit/messages.ts` — result formatting.
- `pi-multi-edit/render.ts` — TUI call/result rendering.
- `pi-multi-edit/workspace.ts` — real and virtual workspace wrappers.

## Behaviors

- Preflight pass runs on a virtual workspace before writing. If preflight fails, no file is modified.
- BOM and line endings (CRLF/LF) are preserved.
- Fuzzy match is used as a fallback for whitespace/quote differences; the result reports success but the model is still encouraged to copy verbatim.
