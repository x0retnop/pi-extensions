# role-sw

Loads a role markdown file and injects it into the system prompt before every LLM turn.

## What it does

- Reads role files from `~/.pi/agent/roles/<role>.md`.
- Appends the active role as a `## Role Override (<role>)` section to the system prompt.
- Stores the active role in a custom session entry (`role-switcher`) so it survives reload and `/resume`.
- Caches role files by mtime.

## Commands

- `/role` — open TUI to pick a role.
- `/role <name>` — switch directly.

Default role is `kimi`.

## Important behaviors

- If the saved role file is missing at restore time, falls back to `kimi`, then to the first available role.
- The injection is a plain markdown append. It can be stripped by `context-guard` if the `roleOverride` rule is disabled.
- `SYSTEM.md` is empty in this setup; the role file is the real system persona.

## State

- `~/.pi/agent/roles/*.md` — role definitions.
- Custom session entries with `customType: "role-switcher"`.

## Source

- `role-sw/index.ts`
