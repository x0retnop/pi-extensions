# System prompt snippets for project memory

Copy the relevant block into the agent system prompt for projects where you want proactive memory use. Keep tool descriptions (`description` / `promptGuidelines` in `index.ts`) focused on *how* to call each tool; these snippets cover *when* and *why*.

## Core discipline

Use this as the default reminder for any project with a `.project-id` file.

```markdown
**Project memory.** This project keeps durable notes about conventions, architecture, patterns, gotchas, historical decisions, and open todos. Recall memory when the task touches any of those, or after reading relevant files when something still feels project-specific. Start with a focused query, glance over the previews, and ask for full detail only on facts that clearly matter. Don't recall memory for greetings, generic questions, trivial edits, or when the current files already answer the question.
```

## Full discipline

Use this for projects where you want agents to own memory end-to-end.

```markdown
## Project memory

This project keeps durable notes about conventions, architecture, patterns, gotchas, historical decisions, and open todos.

- **Recall** when the task touches any of those, or after reading relevant files when something still feels project-specific.
- **Start with a focused query** naming the topic, file, pattern, or decision.
- **Glance over the previews** and ask for full detail only on facts that clearly affect the current step.
- **Do not recall** for greetings, generic questions, trivial edits, or when the current files already answer the question.
- **Save** durable facts only if they would help a future agent in 30 days: non-obvious decisions, gotchas, bug roots, open todos. Skip typos, style fixes, refactors, one-offs, vague summaries.
```

## Minimal reminder

Use this when the system prompt is already crowded.

```markdown
**Memory:** recall project facts for project knowledge; save only durable decisions, gotchas, and todos.
```
