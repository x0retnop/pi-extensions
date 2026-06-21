# pi-sub-agents

Hybrid local/cloud subagent delegation for Pi CLI.

## What it does

- `/sub-agents` — interactive TUI for manually running specialized agents:
  - `Run task` — pick a predefined task file, fill optional `{input}`, and run.
  - `Run agent` — pick a single agent and write a custom task.
  - `Review / Critic` — review last commit, staged changes, a file, or custom diff/text.
  - `Recent runs` — view, rerun, or delete previous invocations stored in `~/.pi/agent/sub-agents-history/`.
  - `Settings` — default cwd, global extensions policy, per-agent extensions policy, and history retention days.
- `/handoff [title]` — generate `handoff-YYYY-MM-DD-[title].md` in the current working directory. Uses the built-in `handoff-gemma` agent shipped with the extension.

There is no agent-facing tool; the user controls every subagent run through the TUI.

## Install

Copy this folder to `~/.pi/agent/extensions/sub-agents/` and restart Pi.

## Agent definitions

Agents are markdown files with YAML frontmatter. The TUI loads agents in this order:

1. `.md` files directly in the current working directory (`cwd`).
2. If none are found, built-in agents shipped inside the extension root (`~/.pi/agent/extensions/sub-agents/`).

`handoff-gemma` is always loaded from the extension folder so `/handoff` works regardless of project-local agents.

Frontmatter fields:

| Field | Description |
|---|---|
| `name` | Agent identifier used in the TUI and history. |
| `description` | Short purpose. |
| `model` | Pi model selector, e.g. `local-llama/gemma-4-e4b-it-xl`. |
| `tools` | Comma-separated allowlist of built-in tools. |
| `includeExtensions` | `true` — load other Pi extensions in the child process. Set `false` to isolate the subagent. |
| `extensions` | Comma-separated list of extension names (or absolute paths) to load explicitly. When set, `includeExtensions` is ignored and only the listed extensions are loaded. |
| `timeoutMs` | Maximum subagent runtime in milliseconds (positive number). |
| `maxTurns` | Maximum assistant turns before the subagent is stopped (positive number). |

## Extension isolation per agent

In addition to the frontmatter fields above, the TUI and settings file support per-agent extension policies:

| Policy | Effect |
|---|---|
| `inherit` | Child loads all active parent extensions. |
| `none` | Child runs isolated (only built-in tools). |
| `custom` | Child loads only the selected extensions from `~/.pi/agent/extensions/`. |

This lets `scout-gemma` stay read-only, `handoff-gemma` stay isolated, and `flash-worker` load helpers like `pi-multi-edit` only when needed.

## Debug logging

Logs are written to `~/.pi/agent/logs/sub-agents/pi-sub-agents.log` by default. Override the directory:

```bash
PI_SUB_AGENTS_LOG_DIR=/path/to/logs pi
```

## Usage examples

Open the TUI:

```
/sub-agents
```

Generate a handoff file:

```
/handoff refactor-auth
```
