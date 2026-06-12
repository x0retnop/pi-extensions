# pi-project-memory

Project-scoped semantic memory for Pi agents. Replaces long handoff files between sessions with searchable fact cards.

## Features

- `project_memory_recent` — quick catch-up on last sessions (handoffs)
- `project_memory_search` — semantic search over facts and decisions
- `project_memory_get` — read full detail of a specific fact
- `project_memory_add` — explicitly save a decision, pattern, or gotcha
- `project_memory_list_todos` — list open tasks for the project

## Install

1. Ensure 0x010 backend has `PROJECT_MEMORY_ENABLED=true` in `.env` and restart it.
2. Copy this folder to `~/.pi/agent/extensions/` and restart Pi.
3. Create `.project-id` in your project root (one line, e.g. `pi-extensions`).

## Commands

### Interactive TUI (recommended)
- `/pm` — opens an interactive menu where you can browse, search, add, edit, and delete records without memorizing syntax.
  - **Browse facts** — list all facts, edit topic/what/why/where/tags inline, or delete
  - **Get record** — pick any record from a searchable list (no need to type item_id)
  - **Update status** — pick a record, then set status
  - **Delete record** — pick a record, confirm, then delete

### Direct CLI commands
- `/pm-status` — show project memory stats
- `/pm-recent [N]` — last N handoff entries
- `/pm-todos [active|done]` — list todos
- `/pm-search <query>` — manual semantic search
- `/pm-add type|topic|what` — save a fact or todo manually
  - Types: `decision`, `pattern`, `gotcha`, `architecture`, `progress`, `todo_item`, `bugfix`
  - Example: `/pm-add decision|API style|All mutations use POST`
- `/pm-handoff topic|what` — save a session handoff (always `progress` type)
  - Example: `/pm-handoff Session 3|Refactored indexer and added tests`
- `/pm-get <item_id>` — read full record detail
- `/pm-update <item_id> <status>` — update status (e.g. `done`, `archived`)
- `/pm-delete <item_id>` — delete a record
