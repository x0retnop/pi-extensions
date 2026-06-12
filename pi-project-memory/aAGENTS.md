# pi-project-memory — Agent Guide

## Role mode

This project uses a **collapsed role model**: one agent handles coding, architecture, and keeper-style cleanup. The full 4-role split from 0x010 does not apply here. Keep changes minimal and reviewable.

## What this is

Cross-session project memory for Pi agents. Replaces long handoff files with searchable "fact cards". 0x010 backend provides vector storage + JSONL persistence; this extension provides tools and commands.

## Quick start

1. Ensure 0x010 has `PROJECT_MEMORY_ENABLED=true` in `.env` and restart it.
2. Copy this folder to `~/.pi/agent/extensions/` and restart Pi.
3. Create `.project-id` in your project root (one line, e.g. `pi-extensions`).

## Backend

- **Backend project:** `C:/10x001/AI comp/0x010`
- **Canonical spec:** `0x010/docs/reference/PROJECT_MEMORY_SPEC.md`
- **Backend module:** `0x010/app/project_memory/`
- **Client API summary:** `docs/reference/API.md`

## Documentation map

| File | Purpose |
|------|---------|
| `README.md` | User-facing install and commands |
| `AGENTS.md` | This file — stable agent rules |
| `AGENT_CONTEXT.md` | Current session focus |
| `changes.txt` | Dated changelog |
| `docs/INDEX.md` | Map of this project's docs |
| `docs/reference/API.md` | 0x010 API contract used by this extension |

## Conventions

- TypeScript, `@earendil-works/pi-coding-agent` extension API.
- No auto-extraction; only explicit save via tool or command.
- Project identity comes from `.project-id` in cwd.
- User-facing strings and command docs live in `README.md`.

## Where to find work

1. `AGENT_CONTEXT.md` — current focus.
2. `README.md` — user-reported gaps in commands.
3. `0x010/docs/reviews/CORE_REGISTRY.md` — if the issue is backend-side.

## Records keeping

- One session = one dated entry in `changes.txt`.
- Update `AGENT_CONTEXT.md` when the focus or open items change.
- Update `docs/reference/API.md` when the 0x010 endpoint contract changes.
- Keep `README.md` user-facing only.
