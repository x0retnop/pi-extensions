# context-guard

Extension-level control over the system prompt and active tool set.

## What it does

- Removes or keeps pieces of the system prompt before each LLM turn (date, cwd, AGENTS.md wrappers, skills, Pi docs, tool snippets, role override).
- Toggles which tools are visible to the LLM (currently `session_memory`).
- Controls automatic skill injection and provides `/use-skill` for manual skill injection.
- Saves all toggles in `~/.pi/agent/settings.json` under the `contextGuard` key.

## Commands

- `/context-guard` or `/context-guard status` — open TUI or print status.
- `/context-guard <id>` — toggle a feature by id.
- `/context-guard reset` — reset all guards to defaults (everything on).
- `/use-skill [name] [comment]` — inject a skill into the next turn.

Toggle ids:

```
date, cwd, agents, ancestorAgents, skills, piDocs, toolSnippets, roleOverride,
autoSkills, sessionMemory
```

## Important behaviors

- **Order matters.** `context-guard` runs on `before_agent_start`. It can strip parts that `role-sw` just injected. If `roleOverride` is disabled, the active role markdown is removed.
- **Ancestor AGENTS.md files.** The `ancestorAgents` rule keeps only the `AGENTS.md` located exactly in `cwd`. It does **not** solve the "two AGENTS.md" problem when Pi is launched inside an extension subfolder — it would strip the root file too.
- **Tool gates** work by calling `pi.setActiveTools()` on `session_start` and `session_tree`. They can conflict with other extensions that also mutate the active tool list.
- **Skills** are discovered once per session from `~/.pi/agent/skills/`, `~/.agents/skills/`, `<cwd>/.pi/skills/`, and `<cwd>/.agents/skills/`.

## State

- Persistent toggles: `~/.pi/agent/settings.json` → `contextGuard.features`, `contextGuard.promptRules`, `contextGuard.autoSkills`.
- Session skill injection queue is in-memory only.

## Dependencies

- Can nullify effects from: `role-sw`, automatic skills, built-in Pi docs, ancestor AGENTS.md files.
- Can hide/show tools provided by: `pi-session-memory` (`session_memory`). `pi-session-memory` reads the same `contextGuard.features.sessionMemory` flag to show an `sm:on` status bar block and mirrors state changes into the session as `session-memory-state` entries.

## Source

- `context-guard/index.ts` — main wiring.
- `context-guard/prompt-rules.ts` — system prompt transformations.
- `context-guard/tool-gates.ts` — active tool management.
- `context-guard/skills.ts` — skill discovery and injection.
- `context-guard/config.ts` — settings persistence.
