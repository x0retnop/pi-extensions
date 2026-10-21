# Configuration
> Adapted from bundled docs `configuration.md` (Pi 1.0.1; the installed package wins if they disagree).

User-level configuration lives in the agent directory, default `~/.pi/agent`. Project configuration lives in `.pi` under the working directory and loads after project trust is granted (`security.md`). Exception: `sessionDir` is read before trust is resolved, so sessions can be located.

In interactive mode, `/settings` changes common preferences. Other options: ask Pi to update the configuration, or edit the files. `/reload` after manually changing settings, keybindings, instructions, or resources.

`<agent-dir>` below is that directory. Set it with `PI_CODING_AGENT_DIR`, or the SDK `agentDir` option (`sdk.md`).

## Agent directory

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.json` | User settings: preferences, defaults, resource paths, Pi package declarations |
| `<agent-dir>/keybindings.json` | Custom terminal UI and application keybindings |
| `<agent-dir>/mcp.json` | MCP servers available in every project |
| `<agent-dir>/models.json` | Compatible endpoints, models, and model overrides |
| `<agent-dir>/auth.json` | Saved API keys and OAuth credentials |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories |
| `<agent-dir>/SYSTEM.md` | Replaces Pi's default system prompt |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to Pi's system prompt |
| `<agent-dir>/extensions/` | User extensions |
| `<agent-dir>/skills/` | User skills and supporting files |
| `<agent-dir>/prompts/` | User prompt templates exposed as slash commands |
| `<agent-dir>/themes/` | User theme files |

## Project .pi directory

| Path | Responsibility |
|---|---|
| `.pi/settings.json` | Project settings, resource paths, and Pi package declarations |
| `.pi/mcp.json` | Project MCP servers |
| `.pi/SYSTEM.md` | Replaces the system prompt for the project |
| `.pi/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt |
| `.pi/extensions/` | Project extensions |
| `.pi/skills/` | Project skills and supporting files |
| `.pi/prompts/` | Project prompt templates exposed as slash commands |
| `.pi/themes/` | Project theme files |

For `SYSTEM.md` and `APPEND_SYSTEM.md`, the trusted project file takes precedence over the corresponding agent-directory file. Files with the same name are not combined.

## Context files

Separate from project `.pi` configuration. Loaded from the agent directory, the working directory, and its parent directories. A context file applies when Pi runs in its directory or anywhere below it.

`AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not suppress context files from the agent directory or from other directories.

Context-file discovery does not require project trust.
