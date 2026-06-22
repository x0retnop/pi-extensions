# pi-multi-edit

Exact-text replacement edit tool with single-file batch and multi-file batch modes.

## What it does

- Replaces the built-in `edit` tool.
- Runs a virtual preflight pass before writing, so mismatches are caught early.
- Supports `edits[]` for one file and `multi[]` for several files.
- Supports `partialApply: true` to apply matching edits and report failures separately.

## Tool

- `edit` — atomic exact text replacement.
  - Single edit: `{ path, oldText, newText }`
  - Same-file batch: `{ path, edits: [{ oldText, newText }, ...] }`
  - Multi-file batch: `{ multi: [{ path, oldText, newText }, ...] }`
  - `partialApply: true` for independent edits.
  - `newText: ""` deletes the matched block.

## Important behaviors

- `oldText` must match exactly, including indentation, quotes, and trailing whitespace.
- If `oldText` appears more than once in the file, the edit fails unless `replaceAll: true`.
- Preflight runs first. If preflight fails and `partialApply` is false, nothing is written.
- Edits inside one file are applied in positional order; later edits can match text introduced by earlier edits in the same batch.
- Preserves BOM and line endings.

## Source

- `pi-multi-edit/index.ts` — tool registration.
- `pi-multi-edit/engine.ts` — apply + preflight logic.
- `pi-multi-edit/params.ts` — input normalization and validation.
- `pi-multi-edit/match.ts` — text matching and mismatch hints.
