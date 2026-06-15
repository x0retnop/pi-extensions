# pi-session-memory — Agent Guide

## Role mode

This project uses a **collapsed role model**: one agent handles coding, architecture, and keeper-style cleanup. Keep changes minimal and reviewable.

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
- **Canonical spec:** `0x010/docs/reference/SESSION_INDEX_SPEC.md`
- **Backend module:** `0x010/app/session_index/`
- **Client API summary:** `docs/reference/API.md`

## Conventions

- TypeScript, `@earendil-works/pi-coding-agent` extension API.
- Use `Type.Object` from `@sinclair/typebox` for tool parameters.
- Keep tools self-contained: fetch 0x010, format results, store session state via `ctx.sessionManager`.
- User-facing docs and commands in `README.md`.

## Where to find work

1. `README.md` — user-reported gaps in commands or workflow.
2. `0x010/docs/reviews/CORE_REGISTRY.md` — if the issue is backend-side.

## Documentation

Keep `AGENTS.md` and `README.md` useful and current. Update `docs/reference/API.md` when the 0x010 endpoint contract changes. Use git for local history review (`git status`, `git diff`, `git log`). There are no required agent commits or report files; commit a meaningful chunk when it is complete and stable if you want to.

## Documentation map

| File | Purpose |
|------|---------|
| `README.md` | User-facing install and usage |
| `AGENTS.md` | This file — stable agent rules |
| `docs/INDEX.md` | Map of this project's docs |
| `docs/reference/API.md` | 0x010 Session Index API contract used by this extension |
