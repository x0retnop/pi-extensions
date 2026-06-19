# pi-sub-agents

Hybrid local/cloud subagent delegation for Pi CLI.

## What it does

- `subagent` tool — delegate isolated tasks to specialized agents:
  - `scout-gemma` — read-only recon using local Gemma-4.
  - `flash-worker` — coding/refactoring using DeepSeek V4 Flash via OpenCode Go.
  - `handoff-gemma` — session summarizer for `/handoff`.
- `/handoff [title]` — generate `handoff-YYYY-MM-DD-[title].md` in the current working directory.

## Install

Copy this folder to `~/.pi/agent/extensions/sub-agents/` and restart Pi.

## Agent definitions

Agents are markdown files with YAML frontmatter, located **directly in cwd** (no subdirectories). If cwd has no `.md` agent files, the extension falls back to the agents shipped inside the extension root (`~/.pi/agent/extensions/sub-agents/`).

Frontmatter fields:

| Field | Description |
|---|---|
| `name` | Agent identifier used in tool calls. |
| `description` | Short purpose. |
| `model` | Pi model selector, e.g. `local-llama/gemma-4-e4b-it-xl`. |
| `tools` | Comma-separated allowlist of built-in tools. |
| `includeExtensions` | `true` — load other Pi extensions in the child process. Set `false` to isolate the subagent. |
| `extensions` | Comma-separated list of extension names (or absolute paths) to load explicitly. When set, `includeExtensions` is ignored and only the listed extensions are loaded. |

## Interactive TUI

Run `/sub-agents` to open a flat, two-level TUI for manual subagent invocation:

- **Run agent** — pick agent, mode (`single`/`parallel`/`chain`), and task(s). The run uses per-agent extension defaults from settings, with an optional override screen for cwd and extensions before launching.
- **Recent runs** — view, rerun, or delete previous invocations stored in `~/.pi/agent/sub-agents-history/`.
- **Settings** —
  - Default cwd
  - Global extensions policy
  - Per-agent extensions policy (e.g. isolate `scout-gemma`/`handoff-gemma`, enable helpers for `flash-worker`)
  - History retention days

Settings are saved in `~/.pi/agent/settings.json` under the `"subAgents"` key. Per-agent extension settings are stored under `subAgents.agentExtensions.<agentName>`.

## Extension isolation per agent

In addition to the frontmatter fields above, the TUI and settings file support per-agent extension policies:

| Policy | Effect |
|---|---|
| `inherit` | Child loads all active parent extensions. |
| `none` | Child runs isolated (only built-in tools). |
| `custom` | Child loads only the selected extensions from `~/.pi/agent/extensions/`. |

This lets `scout-gemma` stay read-only, `handoff-gemma` stay isolated, and `flash-worker` load helpers like `pi-multi-edit` only when needed.

## Debug logging

Logs are written to `pi-sub-agents.log` in the directory where Pi was launched. Override the directory:

```bash
PI_SUB_AGENTS_LOG_DIR=/path/to/logs pi
```

## Usage examples

Single:

```
Use subagent to run scout-gemma: find all auth-related code.
```

Parallel:

```
Run two scouts in parallel: one for models, one for providers.
```

Chain:

```
Chain: first scout-gemma gathers auth code, then flash-worker refactors it based on {previous}.
```

Handoff:

```
/handoff refactor-auth
```
