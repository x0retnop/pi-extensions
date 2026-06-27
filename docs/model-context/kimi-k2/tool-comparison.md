# Editing tool comparison: training data vs. harnesses vs. Pi

This document compares the editing interfaces the Kimi K2.x family was trained on, the interfaces the official Kimi Code CLI exposes, and the current Pi `pi-multi-edit` extension.  The goal is to pick a Pi design that minimizes the gap between the model's training and the tool schema it actually sees.

---

## 1. SWE-agent style (closest to K2.6 training)

From the K2.6 model card and SWE-agent documentation.

```yaml
commands:
  view:      read file or directory
  createfile: create/overwrite file with full content
  strreplace: replace exact old string with new string
  insert:    insert text at a specific line
  bash:      execute shell command
  submit:    mark task complete
```

`strreplace` semantics:
- `path`, `old_string`, `new_string`.
- `old_string` must appear exactly once (no `replace_all` in original SWE-agent ACI).
- Failure modes: not found, multiple occurrences.

---

## 2. Anthropic `str_replace_editor` (de-facto standard)

Used by Claude Code, OpenHands, SWE-agent `edit_anthropic`, and many others.

```json
{
  "command": "str_replace",
  "path": "/abs/path/to/file.py",
  "old_str": "exact text",
  "new_str": "replacement"
}
```

Also supports:
- `command: "view"` with optional `view_range: [start, end]`.
- `command: "create"` with `file_text`.
- `command: "insert"` with `insert_line` and `new_str`.
- `command: "undo_edit"` (in some implementations).

`old_str` uniqueness is enforced.  Multi-line strings are supported.

---

## 3. Kimi Code CLI `StrReplaceFile`

```json
{
  "path": "src/foo.py",
  "edit": {
    "old": "exact text",
    "new": "replacement",
    "replace_all": false
  }
}
```

Or batch:

```json
{
  "path": "src/foo.py",
  "edit": [
    {"old": "a", "new": "b"},
    {"old": "c", "new": "d"}
  ]
}
```

Implementation notes from source:
- Applies edits sequentially in a loop.
- No uniqueness check; `replace_all` toggles `replace()` vs. `replace(count=1)`.
- No preflight or rollback.
- Known bugs with CRLF handling (fixed partially in PR #2362).

---

## 4. Current Pi `pi-multi-edit`

Schema after `prepareArguments`:

```json
{
  "path": "src/foo.py",
  "edits": [
    {"oldText": "a", "newText": "b"},
    {"oldText": "c", "newText": "d"}
  ],
  "partialApply": true
}
```

Features:
- Virtual preflight before writing.
- Batch edits in one file.
- `partialApply` for independent edits.
- Multiple match fallback passes (exact, normalize quotes, trim trailing whitespace, indent normalization).
- Rollback on error.

Differences from K2.x training:
- `oldText`/`newText` instead of `old_string`/`new_string`.
- `edits[]` batch is the primary mode, while training likely used single replacements.
- Heavy normalization may hide from the model what actually matched.

---

## 5. Proposed Pi shape for K2.7 Code

Align with the common denominator (SWE-agent / Anthropic / Kimi CLI single edit):

```json
{
  "path": "src/foo.py",
  "old_string": "exact text",
  "new_string": "replacement text",
  "replace_all": false
}
```

No `edits[]` inside the tool.  If multiple files need edits, the model should emit **parallel independent `edit` tool calls**, which the system prompt should explicitly encourage.

Optional separate tools:
- `insert(path, line, text)` — for line-boundary additions.
- `write(path, content)` — full-file overwrite/create.
- `bash(command)` — shell, tests, git.

This removes the mismatch between the model's single-edit training and the current batch-edit schema.

---

## 6. Why not heredoc/bash as primary

Heredoc and free-form bash editing appear in agent logs, but usually as:
- Implementation details inside tool executors (e.g. SWE-agent's `bin/edit` uses `head`/`echo`/`tail`).
- Fallbacks for humans when structured tools fail.
- Helper scripts the model invokes with structured arguments.

They are **not** the primary interface the model was trained to emit.  Pushing K2.7 Code toward heredoc for routine edits means asking it to generate more tokens in a format with higher error rates (whitespace, quoting, EOF markers) and no preflight.

---

## 7. Decision checklist

| Design choice | Aligns with training? | Risk |
|---|---|---|
| Single `old_string`/`new_string` edit | Yes | Low |
| Parallel tool calls for multiple edits | Yes (CLI encourages this) | Low |
| Batch `edits[]` inside one tool | Maybe not | Medium — model underuses or misuses |
| Free-form bash/heredoc editing | No | High — whitespace and quoting errors |
| Separate `insert` tool | Yes | Low |
| Separate `create` tool | Partial | Low — `write` covers it |
| `replace_all` flag | Yes (Kimi CLI has it) | Low |
