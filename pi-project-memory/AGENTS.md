# pi-project-memory — Agent Guide

## Role mode

This project uses a **collapsed role model**: one agent handles coding, architecture, and keeper-style cleanup. Keep changes minimal and reviewable.

## What this is

Cross-session project memory for Pi agents. The backend (0x010) provides vector storage + JSONL persistence; this extension provides read tools for agents and user-facing commands/TUI for management.

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
- No auto-extraction; facts are saved explicitly via `/done`, `/remember`, or TUI.
- Project identity comes from `.project-id` in cwd.
- User-facing strings and command docs live in `README.md`.
- Extension base URL is read from `PI_PROJECT_MEMORY_URL`, then `PI_BACKEND_URL`, then falls back to `http://127.0.0.1:8000`.

## Agent workflow

Tool-specific usage details live in each tool's `promptGuidelines` inside `index.ts`.

1. **Recall facts** — call `project_facts({ query })` when the user asks about conventions, architecture, or historical decisions.
2. **Recent facts** — call `project_facts({ recent: true, limit: 20 })` to audit the latest memory or prepare for curation.
3. **Curate** — when the curation tool is enabled, use `curate_facts({ action: "list" })`, then `update`, `merge`, or `delete`. Leave correct facts untouched.

## What the user saves

| Kind | Backend category | Use for | Notes |
|------|------------------|---------|-------|
| `fact` | `facts` | Decision, pattern, gotcha, architecture, bugfix | Indexed, eternal |
| `todo` | `todos` | Open task | Not indexed, JSONL only |

## Quality test

Before saving, ask: "Will this help a future agent in 30 days?" If yes, write one concrete sentence in `what`, keep `topic` under 6 words, and pick the right `fact_type`.

## System prompt snippets

Ready-to-copy blocks for other projects live in `docs/reference/SYSTEM_PROMPT_SNIPPETS.md`.

## Where to find work

1. `README.md` — user-facing install and commands.
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
