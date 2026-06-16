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
**Project memory discipline.** The `project_memory_*` tools are your shared notebook across sessions. Use them so future agents do not rediscover the same facts.

- **Start / lost context:** call `project_memory_recent` before asking "where were we".
- **Understand patterns:** call `project_memory_search` before reading 3+ files for "how do we do X". Read the full record with `project_memory_get` if the preview is not enough.
- **Save durable signal only.** Save a record when it explains a non-obvious decision, documents a trap, captures session state, or records an open task.
- **Skip noise.** Do not save typo fixes, style changes, pure refactors, one-off requests, or vague summaries like "we worked on auth".
- **Quality test.** Ask "Will this help a future agent in 30 days?" If yes, write one concrete `what` sentence, keep `topic` under 6 words, and pick the right `kind`/`fact_type`.
- **End session ritual.** Save a `handoff` after meaningful work. Save a `todo` for unfinished work.
```

## Minimal reminder

Use this when the system prompt is already crowded.

```markdown
**Memory:** read `project_memory_recent` at start, `project_memory_search` before archaeology, save only what helps in 30 days, handoff at end.
```
