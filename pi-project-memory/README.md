# Agent guide: pi-project-memory

How Pi agents use the `project_facts` and `curate_facts` tools.

## Core idea

Project memory is a searchable fact store across sessions. Agents read it when they need to recall decisions, patterns, gotchas, architecture, or bug fixes. The user owns saving — either manually via commands or by digesting a session with `/done`.

## Tool purpose map

| Tool | Purpose |
|------|---------|
| `project_facts` | Read durable project facts: search by query or list recent ones. |
| `curate_facts` | Manually-enabled tool to update, merge, or delete stale/duplicate facts. |

## How to use

- Use `project_facts({ query: "..." })` when the user asks about project conventions, architecture, or historical decisions.
- Pass specific technical terms, file names, or framework names.
- Use `project_facts({ recent: true, limit: 20 })` to audit recent memory or prepare for curation.
- `project_facts` returns full records. Each fact is rendered with topic, what, why, where, and tags. Very large results are truncated to protect context.

## Curation workflow

`curate_facts` is hidden by default and enabled via `/pm` → "Curate facts". When enabled:

1. `curate_facts({ action: "list" })` — fetch the latest facts.
2. Inspect the files listed in `where`.
3. Apply changes:
   - **Correct fact** — do nothing.
   - **Stale/wrong fact** — `curate_facts({ action: "delete", item_id, reason })`.
   - **Duplicate facts** — `curate_facts({ action: "merge", source_item_id, target_item_id, fields, reason })`. The source is deleted automatically.
   - **Needs editing** — `curate_facts({ action: "update", item_id, fields, reason })`.

## User commands

The user can manage memory without the agent:

- `/pm` — interactive dashboard (search, browse, add, edit, delete).
- `/remember type|topic|what` — save a fact.
- `/todo topic|what` — save a todo.
- `/done` — digest the current session and save extracted facts.

## Kinds

- `facts` — indexed, searchable durable knowledge. No status; curated via merge/delete.
- `todos` — not indexed, simple JSONL list.

## Quality gate

Before saving, ask: "Will this help a future agent in 30 days?"

Save:
- Non-obvious decisions and architecture.
- Gotchas that caused bugs or wasted time.
- Open tasks that must not be forgotten.

Skip:
- Typo fixes, style changes, pure refactors.
- One-off requests with no lasting trace.
- Vague summaries.
- Anything obvious from the next commit diff.

## System prompt snippets for other projects

See `docs/reference/SYSTEM_PROMPT_SNIPPETS.md` for copy-paste blocks.
