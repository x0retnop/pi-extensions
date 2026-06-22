# pi-session-memory — Agent Guide

> Loaded together with the root `AGENTS.md`. This file contains only guidance specific to `pi-session-memory`.

## What this is

Semantic search over past Pi sessions via the 0x010 Session Vector Index.

## Backend

- **Backend project:** `C:/10x001/AI comp/0x010`
- **Canonical spec:** `0x010/docs/reference/SESSION_INDEX_SPEC.md`
- **Backend module:** `0x010/app/session_index/`
- **Client API summary:** `pi-session-memory/docs/reference/API.md`

## Agent workflow

1. **Search** — call `session_memory({ action: "search", query })` when the user refers to past conversations.
2. **Read** — use `session_memory({ action: "content", hitIndex })` from a previous search result.
3. **List** — use `session_memory({ action: "list", scope: "current" | "all" })` to enumerate sessions.

## Important behaviors

- Never use the raw `read` tool on `.jsonl` session files.
- Backend URL resolution: `PI_SESSION_MEMORY_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000`.
- Last search is stored in session entries so `hitIndex` can be used in subsequent calls.

## Source

- `pi-session-memory/index.ts`
