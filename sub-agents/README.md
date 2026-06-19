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

Run `/sub-agents` to open a TUI for manual subagent invocation:

- **Run agent** — pick an agent, mode, task, extensions policy and either run or copy the generated CLI.
- **Recent runs** — view, rerun or delete previous invocations stored in `~/.pi/agent/sub-agents-history/`.
- **Settings** — default cwd, default extensions policy and history retention days.

Settings are saved in `~/.pi/agent/settings.json` under the `"subAgents"` key.

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
