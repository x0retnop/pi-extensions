# pi-session-memory

Local-only session browser and Markdown export. **No backend, no agent tool** (the old vector-index
half — tool `session_memory`, semantic search, `/sm` Search/Status/Rebuild — was removed 2026-09-20).

## What it does

- **`/sw`** — open a past session quickly. Local list + head scan; does **not** full-parse every `.jsonl` (unlike built-in `/resume` on a large library). Enter = true `switchSession`.
- **`/sm`** — hub: Open · Export session to Markdown · Annotate current session.
- **Export** selected sessions to Markdown in the current cwd.
- **Annotate** — `/note` or `F7` asks the session's own model for a title + summary and stores it in the session file; `/sw` then shows it instead of the first message.

## `/sw` browser

- **Local-only list** — scans `~/.pi/agent/sessions/` by Pi folder encoding + head scan (title, name, tools, size).
- **Scope** (Tab cycles): `project` (cwd + child dirs) → `current` (exact cwd only; skipped when there are no child session dirs) → `projects` (pick a cwd, then its sessions) → `all` (flat mix). Esc from a drilled-in cwd returns to the project picker.
- **Enter / O** — open session (`switchSession`).
- **Open guards**: file must still exist (stale list entries are rejected — reopen `/sw` to refresh); opening from another project asks for confirmation first (switch replaces the active session and jumps cwd); if the target session's stored cwd was deleted, you get the built-in "continue in current cwd?" prompt.
- **P / Space** — local head preview (meta, first users, first assistant sample, tools).
- **E** — export to Markdown.
- **N** — show only annotated sessions (a fallback when a library is full of look-alike first messages).
- **D** — delete `.jsonl` (inline Y/Enter confirm in the browser — never nest `ui.confirm`, it mounts behind the overlay; trash CLI if present; cannot delete the active session).

Annotated rows replace the first-message line with the generated title, add the summary on the
second line behind a `✎` marker, and fall back to the old display when there is no annotation.

## Annotation (`/note`, `F7`)

The request is a **normal user turn** (`sendUserMessage`), so the model that ran the session answers
from its own context — prompt-cache hit on a live session, one cache write on a just-resumed one —
and the reply stays visible in the transcript. Only the parsed result is persisted.

Storage is the **head** of the `.jsonl`: one `custom` entry (`customType: session-memory-note`,
`data.by: session-memory`) inserted after the header, with the first real entry's `parentId`
re-pointed at it so the tree keeps a single root. Re-annotation rewrites that same line — same id,
never a second copy. Why not append at the tail: see `docs/decisions.md` §D32.

Non-obvious consequences:

- **Invisible to the model.** `session_info` and `custom` entries project to zero messages
  (`sessionEntryToContextMessages`), and the request + reply are additionally dropped from later
  calls via `sessionManager.appendContextEdit(id, null)` — visible in the TUI, absent from context.
- **The title also goes to `pi.setSessionName()`**, so the footer and the built-in `/resume` show it
  immediately rather than after a restart. The reader merges our note and any `session_info` by
  timestamp, so a later manual rename wins while the generated summary stays.
- **The write is a full-file temp + rename**, guarded by a size/mtime check, and refuses files over
  64 MB. It never rewrites an existing entry except that one `parentId`.
- **A fork/clone keeps the annotation** (Pi copies non-header entries), unlike a header-field design.
- Reads use the head window plus a 32 KB tail scan — the tail only ever *adds* a newer name/note, so
  losing it to growth costs nothing.

## Export formats

`chat` · `outline` · `outline-reasoning` · `full` · `reasoning` · `real-full`. Writes
`<date>_<title>.<format>.md` to Pi cwd. Limits: skip files > 256 MB; output caps 500k chars
(`real-full` 5M).

**Debugging reasoning context:** `outline-reasoning` shows stored `thinking` blocks next to the final
reply. Combine with `/payload-trace` to verify what was sent to the provider. See
`docs/pi-reasoning-context.md`.

## TUI reliability

Custom pickers use `ui.custom(..., { overlay: true })` and settle via `done(result)`. Never nest
`ui.confirm` / `ui.select` — they mount behind the 95% overlay and leave the outer promise hanging.
Delete confirm is inline (Y/Enter / N/Esc).

## State

Session files on disk only. No settings keys, no status-bar block. The annotation is the one custom
session entry (`session-memory-note`); everything else is derived from the files themselves.
