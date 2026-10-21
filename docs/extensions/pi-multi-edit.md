# pi-multi-edit

Agent-first file editing tools optimized for Kimi K2.x models.

## What it does

Replaces Pi's built-in `edit` tool and adds separate `multi_edit` and `insert` tools. The shapes are chosen to match the `strreplace` / `createfile` / `insert` vocabulary Kimi K2.6/K2.7 Code was trained on, while still supporting batch edits when they are genuinely useful.

## Why three tools?

Modern coding models (Kimi K2.x, Claude) were trained on simple single `str_replace` operations. A complex batch schema inside the primary `edit` tool creates a mismatch: the model tends to under-use batches and falls back to many single edits, re-reading the file each time.

By separating `edit` (single) from `multi_edit` (batch), the model gets:

- A simple, familiar tool for the common case.
- An explicit, well-defined tool for multiple independent replacements.
- Clear guidance on when to use each.

The `insert` tool matches the line-based insertion primitive from the same training vocabulary, avoiding awkward boundary overlap edits.

## Behaviors

- Preflight pass runs on a virtual workspace before writing. If preflight fails, no file is modified.
- `multi_edit` runs the engine in `continueOnError: true` mode, not all-or-nothing — after a partial failure, re-read and retry only the failed steps.
- Same-file edits are serialized per absolute path (`lock.ts`). Parallel `edit`/`multi_edit`/`insert` calls to one file can no longer interleave their read-modify-write cycle — previously the later full-file write silently overwrote the earlier edit while both reported success. Edits to different files still run in parallel.
- BOM and line endings (CRLF/LF) are preserved.
- Fuzzy match is a fallback for whitespace/quote differences only (canonicalization, no similarity thresholds). Every fuzzy candidate is verified against the original bytes before writing: normalization can shift indexes (trailing whitespace, NFKC) above the match, and an unverified index would corrupt the file. Unverifiable candidates fail safely with `NOT_FOUND` + hints — a verbatim retry then exact-matches. Successful fuzzy matches are flagged so the model can copy verbatim next time.
- Error messages include line-number hints when possible.

- **Header while path is late:** Kimi often emits `new_string` before `path`. The call line stays one row: `edit ... +1.8k` (growing new/old **argument size in characters**) until path arrives, then the usual `edit path` / `multi_edit path (4)`. No body preview during stream — height must not jump (see `docs/tool-rendering.md`).
- **Settled row:** the result line carries the file's line delta — `+12 -3` — taken from `details.stats` (the call row cannot know it: it depends on the file content, not on the arguments). The delta is an **LCS of the file before and after**, so `-k` does not mean "the file shrank": rewriting an existing line is always one removal plus one addition, and a single-line rewrite of a 900-line file reads `+1 -1`. `done` is the placeholder for a success that changed nothing (identical `old_string`/`new_string`). Above the LCS budget (both changed regions > 4000 lines, `diff.ts`) the counts degrade to the net line delta and can read `done` on a pure rewrite.

