# pi-project-memory — Current State

## Last updated

2026-06-12

## Status

Extension tools consolidated. The three explicit write tools (`add_fact`, `add_handoff`, `add_todo`) have been merged into a single `project_memory_save` tool with a `kind` parameter. The backend remains unchanged. Extension now exposes 5 LLM tools total: `recent`, `search`, `get`, `save`, `list_todos`.

## Files

- `index.ts` — extension entry point with tools and commands.
- `README.md` — user-facing install and commands.
- `AGENTS.md` — stable agent rules.
- `docs/reference/API.md` — backend contract summary.

## Recent changes

- Replaced `project_memory_add_fact`, `project_memory_add_handoff`, `project_memory_add_todo` with `project_memory_save` (`kind: fact|handoff|todo`).
- Fixed TypeScript typecheck: added `getTextContent()` helper, `kind`/`phase` to `ToolResultDetails`, removed unsupported `cancelable`/`hint` TUI options.
- Updated `AGENTS.md` workflow and tool categories.
- Updated `docs/reference/API.md` Tools section.
- Updated `README.md` usage table.
- Kept CLI commands unchanged (`pm-add-fact`, `pm-add-handoff`, `pm-add-todo`, etc.).
- `project_memory_recent` limit clamped to 1-5.
- `project_memory_search` category filter now only advertises `facts`/`handoffs`.
- `project_memory_get` guideline softened from `ALWAYS` to conditional follow-up.
- BASE_URL configurable via `PI_PROJECT_MEMORY_URL` or `PI_BACKEND_URL`.

## Open items

- Add backend tests (`tests/test_project_memory.py`) for the new `category`/`type` validation guard.
- Smoke-test the `/pm` interactive dashboard after the refactor.

## Notes

- Follow `AGENTS.md` for conventions and cross-project links.
- Run `npm run typecheck` from `C:/10x001/pi extensions` after changes.
- Backend guard is now live; it rejects `progress` in `facts` and `todo_item` in `handoffs`/`facts`.
