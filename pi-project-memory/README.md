# Agent guide: pi-project-memory

How Pi agents use the `project_memory_*` tools. For install, commands, and user-facing docs see `README_user.md`.

## Core idea

Project memory is a shared notebook across sessions. Agents read it before asking "where were we" and write only durable signal — decisions, gotchas, bug roots, session state, open todos.

## Tool purpose map

| Tool | Read / Write | Use for |
|------|--------------|---------|
| `project_memory_recent` | Read | Session start or lost context. Recent handoffs. |
| `project_memory_search` | Read | "How do we do X?" before reading 3+ files. |
| `project_memory_get` | Read | Full record when a search/recent preview is not enough. |
| `project_memory_list_todos` | Read | Remaining work, next steps, open tasks. |
| `project_memory_save` | Write | Durable facts, session handoffs, open todos. |

## Quality gate

Before saving, ask: **"Will this help a future agent in 30 days?"**

Save:
- Non-obvious decisions and architecture.
- Gotchas that caused bugs or wasted time.
- Session state another agent needs to continue.
- Open tasks that must not be forgotten.

Skip:
- Typo fixes, style changes, pure refactors.
- One-off requests with no lasting trace.
- Vague summaries like "we worked on auth".
- Anything obvious from the next commit diff.

## Kinds

- `fact` → `facts` (indexed). Use `fact_type`: `decision`, `pattern`, `gotcha`, `architecture`, `bugfix`.
- `handoff` → `handoffs` (indexed, last 30 kept). Session summary: what was done, what is next.
- `todo` → `todos` (not indexed). Follow-up work.

## Style

- `topic`: under 6 words.
- `what`: one or two concrete sentences. Bad: "we discussed auth". Good: "Auth uses NextAuth credentials provider with bcrypt hashing".
- `why`, `where`, `tags`: only for facts. Paths in `where` should be relative to the project root.

## System prompt snippets for other projects

See `docs/reference/SYSTEM_PROMPT_SNIPPETS.md` for copy-paste blocks you can add to the system prompt of other projects.
