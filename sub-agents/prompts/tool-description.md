# subagent tool description (parent-facing)

This document is the source of truth for the `description` and `promptGuidelines` of the `subagent` tool. The parent model reads this to decide whether and how to delegate.

## Parent decision heuristic

Use `subagent` when a task matches ALL of the following:

1. It is **self-contained** enough to hand to a colleague in one message.
2. It produces **verbose intermediate work** (many file reads, searches, logs) that you do not need in the main conversation.
3. It has a **clear deliverable** you can summarize or act on afterwards.
4. The right agent exists for it (scout for recon, worker for edits, etc.).

Do NOT use `subagent` when:

- The task needs tight back-and-forth with the user.
- The context is already in the main conversation and the change is trivial.
- You are unsure what you want back.

## Bundled agents

| Agent | Use for | Tools | Model |
|-------|---------|-------|-------|
| `scout-gemma` | Fast read-only reconnaissance: list files, summarize code, find call sites, gather context for a later agent. | `read`, `grep`, `find`, `ls` | local Gemma-4 |
| `flash-worker` | Middle-tier coding: edits, refactoring, multi-file changes, moderate debugging. Inherits parent active tools. | parent tools | DeepSeek V4 Flash |
| `handoff-gemma` | Summarize the current session into a structured handoff markdown file. Used by `/handoff`. | `read` | local Gemma-4 |

## Tool parameters

Provide exactly one of `agent`+`task`, `tasks`, or `chain`.

### Single

```json
{
  "agent": "scout-gemma",
  "task": "List all .ts files under src/ and summarize the public exports of each.",
  "cwd": "C:/10x001/pi extensions/my-extension"
}
```

### Parallel

```json
{
  "tasks": [
    { "agent": "scout-gemma", "task": "Find all usages of function foo in src/" },
    { "agent": "scout-gemma", "task": "Find all usages of function bar in src/" }
  ]
}
```

### Chain

```json
{
  "chain": [
    { "agent": "scout-gemma", "task": "Gather context for refactoring auth" },
    { "agent": "flash-worker", "task": "Refactor auth based on this context: {previous}" }
  ]
}
```

`{previous}` is replaced with the previous step's final output.

## Prompt guidelines for the parent

- Default to `scout-gemma` for any read-only recon or context gathering.
- Use `flash-worker` when you need edits, refactoring, or multi-file changes.
- Keep the main agent in control: delegate work, but verify key decisions yourself.
- Always make the `task` self-contained. The subagent cannot see the parent conversation.
- For parallel recon, split by file/module, not by arbitrary chunks.
- For chains, the first step should gather context; later steps should act on `{previous}`.
- If you need a handoff file, use `/handoff` instead of the `subagent` tool.
