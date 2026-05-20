# role-sw

Switch agent roles via `/role` command.

## Install

```bash
pi install ./role-sw
```

## Usage

Place role prompt files in `~/.pi/agent/roles/`:

- `architect_planner.md`
- `code_auditor.md`
- `coding_agent.md`
- `project_keeper.md`

Commands:

- `/role` — interactive TUI select to pick a role.
- `/role <name>` — switch directly (e.g., `/role code_auditor`).

The active role is shown in the TUI status line and persists across reloads and `/resume`.
