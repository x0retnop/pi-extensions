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

Use the `project_memory_*` tools so future agents do not rediscover the same facts. Tool-specific usage details live in each tool's `promptGuidelines` inside `index.ts`.

1. **Start / lost context** — call `project_memory_recent` before asking "where were we" / "где мы были".
2. **Understand patterns** — call `project_memory_search` before reading 3+ files to answer "how do we do X".
3. **Need detail** — call `project_memory_get({ item_id })` using the exact ID from a previous result.
4. **Remaining work** — call `project_memory_list_todos` for open tasks.
5. **Save durable signal** — call `project_memory_save` for decisions, gotchas, bug roots, session state, and open todos. Skip obvious code, style fixes, and vague summaries.

## What to save

| Kind | Backend category | Use for | Notes |
|------|------------------|---------|-------|
| `fact` | `facts` | Decision, pattern, gotcha, architecture, bugfix | Indexed, eternal |
| `handoff` | `handoffs` | Session summary / progress | Indexed, rotated to last 30 |
| `todo` | `todos` | Open task | Not indexed, JSONL only |

## Quality test

Before saving, ask: "Will this help a future agent in 30 days?" If yes, write one concrete sentence in `what`, keep `topic` under 6 words, and pick the right `kind` and `fact_type`.

## System prompt snippets

Ready-to-copy blocks for other projects live in `docs/reference/SYSTEM_PROMPT_SNIPPETS.md`.

## Where to find work

1. `README.md` — user-reported gaps in commands.
2. `0x010/docs/reviews/CORE_REGISTRY.md` — if the issue is backend-side.

## Documentation

Keep `AGENTS.md` and `README.md` useful and current. Update `docs/reference/API.md` when the 0x010 endpoint contract changes. Use git for local history review (`git status`, `git diff`, `git log`). There are no required agent commits or report files; commit a meaningful chunk when it is complete and stable if you want to.

## Documentation map

| File | Purpose |
|------|---------|
| `README.md` | Agent-facing guide for using the memory tools |
| `README_user.md` | User-facing install and commands |
| `AGENTS.md` | Stable agent rules for this project |
| `.project-id` | Project identity for memory binding |
| `docs/INDEX.md` | Map of this project's docs |
| `docs/reference/API.md` | 0x010 Project Memory API contract used by this extension |
| `docs/reference/SYSTEM_PROMPT_SNIPPETS.md` | Copy-paste system prompt blocks for other projects |
