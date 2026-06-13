# pi-session-memory — Current State

## Last updated

2026-06-13

## Status

Refactored to a single agent tool and a unified TUI command.

## Files

- `index.ts` — extension entry point with one tool (`session_memory`) and one command (`/session-memory`).
- `README.md` — user-facing install and usage.
- `AGENTS.md` — stable agent rules.

## Recent changes

- Unified agent tool: `session_memory(action: "search" | "content" | "list")`.
- Removed legacy `search_sessions` and `get_session_content` aliases.
- Unified UI command `/session-memory` replaces `/session-memory-status`, `/session-memory-rebuild`, `/session-memory-resume`.
- Backend `session_content` default `tool_result_limit` raised to `1000`.
- Backend `list` endpoint now returns a readable `project` path.
- Backend `SessionIndexBuilder` batches embeddings with configurable `embed_batch_size` (default 64).

## Open items

- None.

## Notes

- Follow `AGENTS.md` for conventions and cross-project links.
- Backend canonical spec: `0x010/docs/reference/SESSION_INDEX_SPEC.md`.
