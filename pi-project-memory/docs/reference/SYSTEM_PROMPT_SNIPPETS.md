# System prompt snippets for project memory

Copy the relevant block into the agent system prompt for projects where you want proactive memory use. Keep tool descriptions (`description` / `promptGuidelines` in `index.ts`) focused on *how* to call each tool; these snippets cover *when* and *why*.

## Core discipline

Use this as the default reminder for any project with a `.project-id` file.

```markdown
**Project memory.** Use `project_memory_recent` at session start or when context is lost. Use `project_memory_search` before reading many files to answer "how do we do X". Save records only if they will help a future agent in 30 days: decisions, gotchas, bug roots, session state, open todos. Skip obvious code, style fixes, and vague summaries.
```

## Full discipline

Use this for projects where you want agents to own memory end-to-end.

```markdown
## Project memory

- Read `project_memory_recent` at session start or when the user lost context.
- Use `project_memory_search` before reading 3+ files to answer "how do we do X"; read full records with `project_memory_get` when previews are not enough.
- Save only what passes the "30 days" test: would a future agent need this to avoid re-discovering it?
  - Save: non-obvious decisions, gotchas/bug roots, session state, open todos.
  - Skip: typos, style fixes, pure refactors, one-off user requests, vague summaries.
- Save a `handoff` when ending a session with meaningful progress. Save a `todo` for any work left for next time.
```

## Minimal reminder

Use this when the system prompt is already crowded.

```markdown
**Memory:** read `project_memory_recent` at start, `project_memory_search` before archaeology, save only what helps in 30 days, handoff at end.
```
