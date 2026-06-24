# role-sw

Loads a role markdown file from the extension's local `roles/` directory and injects it into the system prompt before every LLM turn.

## What it does

- Reads role files from `role-sw/roles/<role>.md` (next to the extension's `index.ts`).
- Resolves `{{include:filename.md}}` directives by loading fragments from the same `roles/` directory.
- Ignores `README.md` when scanning available roles.
- Appends the resolved role as a `## Role Override (<role>)` section to the system prompt.
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
- Circular includes are skipped with an HTML comment marker.
- Missing includes are replaced with an HTML comment marker.

## State

- `role-sw/roles/*.md` — role definitions and shared include fragments.
- Custom session entries with `customType: "role-switcher"`.

## Source

- `role-sw/index.ts`
