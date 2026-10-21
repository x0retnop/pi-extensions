# role-sw

Switch agent roles via `/role` command. Role files are versioned by name and the newest version of a family is picked up automatically.

## Install

```bash
pi install ./role-sw
```

## Usage

Role prompt files do **not live in this repo** — they are edited and versioned at runtime in
`~/.pi/agent/extensions/role-sw/roles/` (git-ignored here; the folder stays empty in the working tree
on purpose, and `sync-extensions.ps1` never touches runtime role files: it only prunes `.ts` and
per-extension `package.json`). Put them there, next to the deployed `index.js`:

- `agent-core-v4.md` — versioned: addressed as `agent-core`
- `chat-v2.md` — versioned: addressed as `chat`
- `sub-default.md` — plain role (no version)
- `_Sub-agents.md` — fragment, filled in by `sub-agents`, never listed

A file named `<family>-v<N>.md` belongs to family `<family>`. The suffix must be the last token — `sub-ds-v4-flash` is a plain name, not a family. The alias always resolves to the **highest** `N` on disk (numeric: `v10` > `v9`), re-resolved on every agent run, so putting a new version in and deleting the old one needs no config edit and no Pi restart.

`README.md` and `_*.md` are ignored when scanning available roles.

## Commands

- `/role` — interactive TUI select to pick a role (one entry per family).
- `/role agent-core` — switch directly by alias; `/role agent-core-v3` works too but resolves to the newest version.
- `/role-config` — configure the default role mode (`fixed <alias>` or `latest`).
- `/role-config` — the default role is stored as an **alias**, so it survives version bumps.

The active role is shown in the TUI status line as the concrete file name (`role:agent-core-v4`) and persists across reloads and `/resume`.

Settings live in `~/.pi/agent/settings.json` → `roleSwitcher` (`defaultMode`, `fixedRole`, `modelRoleMap`) plus per-model role mappings edited from `/mm`.

## Role composition with `{{include:...}}`

Role files can include shared markdown fragments from the same `roles/` directory:

```markdown
# Role: Coding Agent

## Identity
Expert coding assistant with direct tool access to the live filesystem, shell, and network.

## Base Operating Rules
{{include:base.md}}

## Session Triggers
...
```

- Circular includes are skipped with an HTML comment marker.
- Missing includes are replaced with an HTML comment marker.
