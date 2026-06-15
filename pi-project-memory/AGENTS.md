# pi-project-memory — Agent Guide

## Role mode

This project uses a **collapsed role model**: one agent handles coding, architecture, and keeper-style cleanup. Keep changes minimal and reviewable.

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

## Conventions

- TypeScript, `@earendil-works/pi-coding-agent` extension API.
- No auto-extraction; only explicit save via tool or command.
- Project identity comes from `.project-id` in cwd.
- User-facing strings and command docs live in `README.md`.
- Extension base URL is read from `PI_PROJECT_MEMORY_URL`, then `PI_BACKEND_URL`, then falls back to `http://127.0.0.1:8000`.

## Agent workflow

This is the operational flow the extension expects from agents. Tool-specific triggers and examples live in each tool's `promptGuidelines` inside `index.ts`.

1. **Start of a new session** — call `project_memory_recent` to catch up. Do not ask the user "where did we stop" before reading recent handoffs.
2. **User asks about conventions, architecture, or "how do we do X"** — call `project_memory_search` first. Only read multiple files if search returns nothing useful.
3. **Search/recent preview is not enough** — call `project_memory_get({ item_id })` using the exact ID from the previous result.
4. **User asks about remaining work or todos** — call `project_memory_list_todos` (todos are not searchable).
5. **After a non-trivial decision, refactor, bugfix, or gotcha** — offer to call `project_memory_save` with `kind: "fact"`.
6. **At the end of a meaningful session** — offer to call `project_memory_save` with `kind: "handoff"`.
7. **When a follow-up task appears** — offer to call `project_memory_save` with `kind: "todo"`.

## Tool categories

| What to save | Tool | Backend category | Notes |
|--------------|------|------------------|-------|
| Decision, pattern, gotcha, architecture, bugfix | `project_memory_save` with `kind: "fact"` | `facts` | Indexed, eternal |
| Session summary / progress | `project_memory_save` with `kind: "handoff"` | `handoffs` | Indexed, rotated to last 30 |
| Open task | `project_memory_save` with `kind: "todo"` | `todos` | Not indexed, JSONL only |

## Where to find work

1. `README.md` — user-reported gaps in commands.
2. `0x010/docs/reviews/CORE_REGISTRY.md` — if the issue is backend-side.

## Documentation

Keep `AGENTS.md` and `README.md` useful and current. Update `docs/reference/API.md` when the 0x010 endpoint contract changes. Use git for local history review (`git status`, `git diff`, `git log`). There are no required agent commits or report files; commit a meaningful chunk when it is complete and stable if you want to.

## Documentation map

| File | Purpose |
|------|---------|
| `README.md` | User-facing install and commands |
| `AGENTS.md` | This file — stable agent rules |
| `.project-id` | Project identity for memory binding |
| `docs/INDEX.md` | Map of this project's docs |
| `docs/reference/API.md` | 0x010 Project Memory API contract used by this extension |
