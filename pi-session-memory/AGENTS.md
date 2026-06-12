# pi-session-memory — Agent Guide

## Role mode

This project uses a **collapsed role model**: one agent handles coding, architecture, and keeper-style cleanup. The full 4-role split from 0x010 does not apply here. Keep changes minimal and reviewable.

## What this is

Pi extension for semantic search over past agent sessions via the 0x010 Session Vector Index.

## Quick start

```bash
# Install into Pi
pi install ./pi-session-memory
```

Requirements:
- 0x010 server running on `127.0.0.1:8000`
- `SESSION_INDEX_ENABLED=true` in 0x010 `.env`
- Embedding server on port `8088`

## Backend

- **Backend project:** `C:/10x001/AI comp/0x010`
- **Canonical spec:** `0x010/docs/reference/SESSION_INDEX_SPEC.md` *(create if missing)*
- **Backend module:** `0x010/app/session_index/`
- **Client API summary:** `docs/reference/API.md`

## Documentation map

| File | Purpose |
|------|---------|
| `README.md` | User-facing install and usage |
| `AGENTS.md` | This file — stable agent rules |
| `AGENT_CONTEXT.md` | Current session focus and state |
| `changes.txt` | Dated changelog |
| `docs/INDEX.md` | Map of this project's docs |
| `docs/reference/API.md` | 0x010 API contract used by this extension |

## Conventions

- TypeScript, `@earendil-works/pi-coding-agent` extension API.
- Use `Type.Object` from `@sinclair/typebox` for tool parameters.
- Keep tools self-contained: fetch 0x010, format results, store session state via `ctx.sessionManager`.
- User-facing docs and commands in `README.md`.

## Where to find work

1. `AGENT_CONTEXT.md` — current focus.
2. `README.md` — user-reported gaps in commands or workflow.
3. `0x010/docs/reviews/CORE_REGISTRY.md` — if the issue is backend-side.

## Records keeping

- One session = one dated entry in `changes.txt`.
- Update `AGENT_CONTEXT.md` when the focus or open items change.
- Update `docs/reference/API.md` when the 0x010 endpoint contract changes.
- Keep `README.md` user-facing only.
