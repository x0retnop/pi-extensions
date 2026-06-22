# pi-project-memory

Durable project memory: facts and todos stored in the 0x010 backend.

## What it does

- Provides the `project_facts` tool for agents to recall project conventions, decisions, patterns, and gotchas.
- Provides the `curate_facts` tool for reviewing and cleaning up memory (must be enabled manually).
- User commands (`/pm`, `/remember`, `/todo`, `/done`) for interactive management.

## Tools

- `project_facts` — semantic search or recent listing of project facts.
- `curate_facts` — list/update/merge/delete facts (hidden unless curation is enabled).

## Commands

- `/pm` — interactive dashboard.
- `/remember type|topic|what` — save a fact. Types: `decision`, `pattern`, `gotcha`, `architecture`, `bugfix`.
- `/todo topic|what` — save a todo.
- `/done` — extract candidate facts from the current session with a local LLM and review them.

## Important behaviors

- **Requires `.project-id` file in `cwd`.** If absent, `project_facts` and `curate_facts` are hidden from the LLM (but `/pm` still works and tells the user to create `.project-id`).
- **Backend URL resolution**: `PI_PROJECT_MEMORY_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000`.
- Fallback project id is derived from `path.basename(cwd)` if `.project-id` is missing; tools still refuse until the file exists.
- `/done` builds a transcript from the current branch, sends it to `/api/project_memory/extract`, and lets the user review candidate facts.

## State

- Persistent data lives in the 0x010 backend (vector store + JSONL).
- `~/.pi/agent/settings.json` → `projectMemory.debug` for diagnostic logging.
- Custom session entries with `customType: "project-memory-curate-state"` for curation mode.

## Source

- `pi-project-memory/index.ts`
