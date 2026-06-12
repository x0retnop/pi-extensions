# pi-project-memory — Current State

## Last updated

2026-06-12

## Status

Backend module and extension are functional. Last session verified all 8 endpoints, handoff rotation, and orphan vector cleanup.

## Files

- `index.ts` — extension entry point with tools and commands.
- `README.md` — user-facing install and commands.
- `AGENTS.md` — stable agent rules.

## Open items

- Add backend tests (`tests/test_project_memory.py`) when next session touches the backend module.
- Consider richer `/pm-add` syntax (`why`, `where`, `tags`) if requested.

## Notes

- Follow `AGENTS.md` for conventions and cross-project links.
