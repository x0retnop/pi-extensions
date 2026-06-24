# role-sw

Switch agent roles via `/role` command.

## Install

```bash
pi install ./role-sw
```

## Usage

Place role prompt files in `roles/` next to this extension's `index.ts`:

- `roles/architect_planner.md`
- `roles/code_auditor.md`
- `roles/coding_agent.md`
- `roles/kimi.md`
- `roles/project_keeper.md`
- `roles/base.md` — shared rules included by role files

Commands:

- `/role` — interactive TUI select to pick a role.
- `/role <name>` — switch directly (e.g., `/role code_auditor`).

The active role is shown in the TUI status line and persists across reloads and `/resume`.

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

- `README.md` is ignored when scanning available roles.
- Circular includes are skipped with an HTML comment marker.
- Missing includes are replaced with an HTML comment marker.
