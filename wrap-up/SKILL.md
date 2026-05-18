---
name: wrap-up
description: "End session cleanly. Auto-detects: if work is done → update docs and suggest cleanup; if not → prepare a compact handoff for /new. Use when user says 'wrap up', 'done', 'finish session', 'close out', 'handoff'."
---

# Wrap-up

## Detect mode

**Finish** — goal achieved, no open blockers, user indicates completion.
**Handoff** — work incomplete, context full, or user says "continue later".

## Finish flow

- Update `AGENT_CONTEXT.md` / project context: mark done, remove stale tasks.
- Update docs if new features/files were added.
- Note changes for `changes.txt` / `CHANGELOG`.
- Move obsolete plans to `docs/archive/`.
- Remind: "Don't forget to commit."
- Show cleanup list (user deletes manually).

## Handoff flow

- Update `AGENT_CONTEXT.md` with current state.
- Generate compact handoff prompt (markdown block).
- Include: done, not done, next step, gotchas, relevant files.
- Tell user: copy block, `/new`, paste, Enter.

## Rules

- Never auto-commit. Never auto-delete.
- Handoff < 800 tokens. No history dumps.
- If no `AGENT_CONTEXT.md`, use `wrap-up.md`.
