# context-guard

Centralized control over Pi's context injections, skills, tool gates, and full-context inspection.

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

Only two slash commands are exposed:

- `/context-guard` — unified interactive TUI with everything inside:
  - Prompt rules
  - Tool gates
  - Skills
  - Inspect prompt breakdown
  - Context overview
  - Dump full LLM context
  - Reset all guards
- `/context-guard <id>` — toggle a feature directly, e.g. `/context-guard sessionMemory`
- `/context-guard reset` — disable all guards
- `/use-skill [name] [comment]` — manually inject a skill into the next turn

No other `/` aliases are registered, so the command list stays minimal.

## Full context dump

The extension captures real data as Pi builds each LLM request:

- `before_agent_start` — final system prompt, options, user prompt, images
- `context` — messages that will be sent to the LLM
- `before_provider_request` — raw provider payload
- `pi.getAllTools()` / `pi.getActiveTools()` — actual active/inactive tools

In the TUI: `/context-guard` → "Dump full context". Choose:

- **File (full/brief)** — writes `pi-context-dump-<cwd-basename>-<timestamp>.md` into the current working directory (`ctx.cwd`)
- **Editor (full/brief)** — opens the report in Pi's built-in editor

The dump reflects the current state **after** all extensions and guard settings have been applied, **but only after at least one LLM turn has been executed**. If you run the dump before the first provider request, the system prompt section shows the base prompt **before** extensions such as `role-sw` and `context-guard` mutate it.

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

No further registration is required; the TUI and `/context-guard <id>` command pick them up automatically.
