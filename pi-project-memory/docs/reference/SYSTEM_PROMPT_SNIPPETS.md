# System prompt snippets for project memory

Copy the relevant block into the agent system prompt for projects where you want proactive memory use. Keep tool descriptions (`description` / `promptGuidelines` in `index.ts`) focused on *how* to call each tool; these snippets cover *when* and *why*.

## Core discipline

Use this as the default reminder for any project with a `.project-id` file.

```markdown
**Project memory.** Use `project_facts({ query })` when the user asks about project conventions, architecture, or historical decisions. Use `project_facts({ recent: true, limit: 20 })` to audit recent memory. Save durable facts via `/remember` or `/done` only if they will help a future agent in 30 days: decisions, gotchas, bug roots, open todos. Skip obvious code, style fixes, and vague summaries.
```

## Full discipline

Use this for projects where you want agents to own memory end-to-end.

```markdown
## Project memory

- Use `project_facts({ query })` when the user asks about a convention, pattern, or historical decision in the project.
- Use `project_facts({ recent: true, limit: 20 })` to audit the latest facts or prepare for curation.
- Save only what passes the "30 days" test: would a future agent need this to avoid re-discovering it?
  - Save: non-obvious decisions, gotchas/bug roots, open todos.
  - Skip: typos, style fixes, pure refactors, one-off user requests, vague summaries.
- Suggest `/done` when ending a session with meaningful progress.
```

## Minimal reminder

Use this when the system prompt is already crowded.

```markdown
**Memory:** use `project_facts` for project knowledge; `/done` to digest a session; `/remember` for quick facts.
```
