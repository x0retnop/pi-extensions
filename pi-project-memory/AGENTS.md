# pi-project-memory — Agent Guide

> Loaded together with the root `AGENTS.md`. This file contains only guidance specific to `pi-project-memory`.

## What this is

Durable project memory backed by the 0x010 backend. Agents can recall facts and curate memory; users manage facts/todos via commands and TUI.

## Backend

- **Backend project:** `C:/10x001/AI comp/0x010`
- **Canonical spec:** `0x010/docs/reference/PROJECT_MEMORY_SPEC.md`
- **Backend module:** `0x010/app/project_memory/`
- **Client API summary:** `pi-project-memory/docs/reference/API.md`

## Agent workflow

1. **Recall facts** — call `project_facts({ query })` when the user asks about conventions, architecture, or historical decisions.
2. **Recent facts** — call `project_facts({ recent: true, limit: 20 })` to audit the latest memory.
3. **Curate** — when curation is enabled, use `curate_facts({ action: "list" })`, then `update`, `merge`, or `delete`. Leave correct facts untouched.

## Important behaviors

- Tools are hidden from the LLM unless `.project-id` exists in `cwd`.
- Backend URL resolution: `PI_PROJECT_MEMORY_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000`.

## Source

- `pi-project-memory/index.ts`
