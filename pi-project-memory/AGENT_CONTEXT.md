# pi-project-memory — Current State

## Last updated

2026-06-12

## Status

Extension refactor completed. Split the generic `project_memory_add` tool into three explicit tools (`add_fact`, `add_handoff`, `add_todo`) so the agent always knows which backend category it is writing to. Fixed `progress` so it maps to `handoffs` instead of `facts`. Recent/search previews now include `item_id`, making follow-up `project_memory_get` reliable.

## Files

- `index.ts` — extension entry point with tools and commands.
- `README.md` — user-facing install and commands.
- `AGENTS.md` — stable agent rules.
- `docs/reference/API.md` — backend contract summary.

## Recent changes

- Added `project_memory_add_fact`, `project_memory_add_handoff`, `project_memory_add_todo`.
- Kept `project_memory_add` as a legacy command alias only.
- `project_memory_recent` limit clamped to 1-5.
- `project_memory_search` category filter now only advertises `facts`/`handoffs`.
- `project_memory_get` guideline softened from `ALWAYS` to conditional follow-up.
- BASE_URL configurable via `PI_PROJECT_MEMORY_URL` or `PI_BACKEND_URL`.
- Deduplicated command notification/error handling.
- Updated `docs/reference/API.md` with `list_all` and `update_full`.

## Open items

- Add backend tests (`tests/test_project_memory.py`) for the new `category`/`type` validation guard.
- Smoke-test the `/pm` interactive dashboard after the refactor.

## Notes

- Follow `AGENTS.md` for conventions and cross-project links.
- Run `npm run typecheck` from `C:/10x001/pi extensions` after changes.
- Backend guard is now live; it rejects `progress` in `facts` and `todo_item` in `handoffs`/`facts`.
