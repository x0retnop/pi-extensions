# context-guard

Centralized control over Pi's context injections, skills, and tool gates.

## What it controls

| Area | Feature id | Description |
|------|------------|-------------|
| **Prompt rules** | `date` | `Current date` stamp |
| | `cwd` | `Current working directory` stamp |
| | `agents` | `<project_context>` wrapper for AGENTS.md / CLAUDE.md |
| | `ancestorAgents` | Keep only the context file from the current directory |
| | `skills` | `<available_skills>` block |
| | `piDocs` | Default Pi docs block |
| | `toolSnippets` | "Available tools" and "Guidelines" lists |
| | `roleOverride` | `## Role Override` injected by `role-sw` |
| **Skills** | `autoSkills` | Automatic skill injection |
| **Tool gates** | `sessionMemory` | `session_memory` tool |

## Commands

- `/ctx-guard` — interactive TUI (prompt rules, tool gates, skills, inspect, reset)
- `/ctx-guard <id>` — toggle a feature directly, e.g. `/ctx-guard sessionMemory`
- `/ctx-guard reset` — disable all guards
- `/ctx-inspect` — full system prompt breakdown with token estimates
- `/context` — compact overview of loaded context, extensions, skills, and usage
- `/skills` — list discovered skills and auto-skill status
- `/use-skill [name] [comment]` — manually inject a skill into the next turn

## Settings

Stored in `~/.pi/agent/settings.json` under `contextGuard`:

```json
{
  "contextGuard": {
    "promptRules": {
      "date": true,
      "cwd": true,
      "skills": false
    },
    "autoSkills": false,
    "features": {
      "sessionMemory": true
    }
  }
}
```

Missing keys default to enabled (`true`).

## Adding new managed features

1. **Prompt rule**: add an entry to `prompt-rules.ts` with `id`, `label`, and `apply()`.
2. **Tool gate**: add an entry to `tool-gates.ts` with `id`, `toolsOn`, and `toolsOff`.
3. **Skill control**: already handled by `autoSkills`.

No further registration is required; the TUI and `/ctx-guard <id>` command pick them up automatically.
