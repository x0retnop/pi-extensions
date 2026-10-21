# context-guard

Centralized control over Pi's context injections, skills, tool gates, and full-context inspection.

## What it controls

| Area | Feature id | Description |
|------|------------|-------------|
| **Prompt rules** | `date` | `Current date` stamp |
| | `cwd` | `Current working directory` stamp |
| | `agents` | `<project_context>` wrapper for AGENTS.md / CLAUDE.md |
| | `ancestorAgents` | Keep only the context file from the current directory |
| | `piDocs` | Default Pi docs block |
| | `toolSnippets` | "Available tools" and "Guidelines" lists |
| | `roleOverride` | `## Role Override` injected by `role-sw` (enforced at payload level — see below) |
| **Skills** | `autoSkills` | Automatic skill injection (the only skills switch) |
| **Tool gates** | `bash` | Built-in `bash` shell tool |
| **Context notices** | (TUI) | One-shot 60%/70% user-shaped pressure notices (`notice-60.md` / `notice-70.md`) |

## Boot checklist

On every session bind (`startup` / `reload` / `new` / `resume` / `fork`) a compact **enabled-only** ribbon appears **once** as a chat line (`notify`). Frame / rails / extras come from `uiTheme.boot` (ui-theme preset).

## Commands

Slash commands exposed:

- `/context-guard` — unified interactive TUI with everything inside:
  - Prompt rules
  - Tool gates
  - Skills
  - Context notices (master + 60%/70% toggles, clear fired, reload prompts)
  - Inspect prompt breakdown
  - Context overview
  - Dump full LLM context
  - Reset all guards
- `/context-guard <id>` — toggle a feature directly, e.g. `/context-guard bash`
- `/context-guard reset` — restore defaults (everything ON)
- `/context` — context overview (window fill, real token counts, skills)
- `/use-skill [name] [comment]` — manually inject a skill into the next turn

## What actually goes to the LLM

Two mechanisms keep the toggles honest:

1. **Payload enforcement.** Besides mutating the prompt in `before_agent_start`, context-guard also hooks `before_provider_request` and re-strips everything disabled from the *actual outgoing payload* (idempotent, strip-only). This catches text appended by extensions that run later (e.g. `role-sw`), so an OFF toggle really means the content does not leave.
2. **Reality-based inspect/overview.** The inspect report and `/context` overview anchor on the final system prompt captured from the last real provider request, plus the API-reported token usage of the last assistant turn — not just chars/4 estimates. Estimates are labeled `(est.)`.

## Full context dump

The extension captures real data as Pi builds each LLM request:

- `before_agent_start` — final system prompt, options, user prompt, images
- `context` — messages that will be sent to the LLM
- `before_provider_request` — raw provider payload
- `pi.getAllTools()` / `pi.getActiveTools()` — actual active/inactive tools

In the TUI: `/context-guard` → "Dump full context". Choose:

- **File (full/brief)** — writes `pi-context-dump-<cwd-basename>-<timestamp>.md` into the current working directory (`ctx.cwd`)
- **View (full/brief)** — opens the report in a read-only scrollable viewer (q/Esc to close)

The dump prefers the system prompt extracted from the last provider payload. Before the first request it shows the base prompt (pre-extension). If a request was sent but the payload shape is unrecognized, it says so and falls back to the session prompt **after** extensions — not the pre-mutation base.

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
      "bash": true
    },
    "contextNotices": {
      "enabled": false,
      "notice60": true,
      "notice70": true
    }
  }
}
```

Missing prompt/feature keys default to enabled (`true`). Context notices master defaults to **off**.

## Adding new managed features

1. **Prompt rule**: add an entry to `prompt-rules.ts` with `id`, `label`, and `apply()`.
2. **Tool gate**: add an entry to `tool-gates.ts` with `id`, `toolsOn`, and `toolsOff`.
3. **Skill control**: already handled by `autoSkills`.

No further registration is required; the TUI and `/context-guard <id>` command pick them up automatically.
