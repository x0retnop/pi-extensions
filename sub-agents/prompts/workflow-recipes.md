# subagent workflow recipes

Concrete delegation patterns that the parent agent can use.

## Recon → plan → implement

Use when you need to make a non-trivial change and want the worker to have full context.

```json
{
  "chain": [
    { "agent": "scout-gemma", "task": "Find all files and call sites related to [feature]. Return relevant files, key functions, and any risks." },
    { "agent": "flash-worker", "task": "Implement [change] based on this context: {previous}" }
  ]
}
```

## Parallel recon

Use when you need to scan multiple areas at once.

```json
{
  "tasks": [
    { "agent": "scout-gemma", "task": "Find all usages of auth middleware in src/" },
    { "agent": "scout-gemma", "task": "Find all route definitions in src/routes" },
    { "agent": "scout-gemma", "task": "Summarize the user model in src/models" }
  ]
}
```

## Implement → review

Use when you want a second pair of eyes on a change.

```json
{
  "chain": [
    { "agent": "flash-worker", "task": "Refactor [file] to [goal]. Run typecheck if applicable." },
    { "agent": "scout-gemma", "task": "Review the changes from the previous step: {previous}. Check for correctness, edge cases, and style issues." }
  ]
}
```

## Handoff generation

Use the slash command:

```
/handoff [short-title]
```

This runs `handoff-gemma` over the current session and writes `handoff-YYYY-MM-DD[-short-title].md`.

## Anti-patterns

- Do not delegate tasks that need user clarification mid-flight.
- Do not use subagents for trivial single-file edits you can do yourself.
- Do not chain more than 3-4 steps without a clear reason; long chains compound latency and failure risk.
- Do not forget that subagents start with zero context. Always include file paths and decisions in the task.
