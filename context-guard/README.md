# context-guard

Centralized control over Pi's automatic context injections.

## What it does

Pi unconditionally appends several things to every LLM request:

- `Current date: YYYY-MM-DD`
- `Current working directory: <cwd>`
- XML wrappers around `AGENTS.md` / `CLAUDE.md`
- XML wrappers around skills (`<available_skills>`)
- Default Pi docs / tools / guidelines block (when no `SYSTEM.md` is used)

This extension lets you **inspect** and **remove** those layers per-rule, so you don't have to fight them in every other extension.

## Commands

- **`/ctx-inspect`** — show a full breakdown of the current system prompt layers with token estimates
- **`/ctx-guard`** — show active guard rules
- **`/ctx-guard <rule>`** — toggle a rule on/off:
  - `date` — remove `Current date`
  - `cwd` — remove `Current working directory`
  - `agents` — remove `<project_context>` wrapper
  - `ancestor-agents` — keep only the `AGENTS.md` / `CLAUDE.md` from the current directory; drop parent/ancestor files
  - `skills` — remove `<available_skills>` block
  - `pi-docs` — remove default Pi docs block
  - `tool-snippets` — remove "Available tools" / "Guidelines" lists from default prompt
  - `role-override` — remove `## Role Override` injected by `role-sw`
- **`/ctx-guard reset`** — disable all rules

## How it works

Rules are stored in `~/.pi/agent/settings.json` under `"contextGuard"`.

The extension hooks `before_agent_start` and strips matching blocks from `event.systemPrompt` **after** all other extensions have appended their pieces. This means:

- `role-sw` can keep adding its role override
- `pi-skill-guard` can keep injecting skills
- `context-guard` sits at the end of the chain and cleans up the final prompt

No more "one extension adds, another removes" — one knob for Pi's auto-injections.

## Example settings.json

```json
{
  "contextGuard": {
    "removeCwd": true,
    "removeDate": true,
    "removeAgentsWrapper": false,
    "removeAncestorAgents": false,
    "removeSkills": false,
    "removePiDocsBlock": false,
    "removeToolSnippets": false,
    "removeRoleOverride": false
  }
}
```

## Why centralized?

Instead of every extension (role-sw, skill-guard, etc.) adding and removing pieces, this extension sits at the end of the `before_agent_start` chain and cleans up the final prompt. Other extensions can stay simple and additive.
