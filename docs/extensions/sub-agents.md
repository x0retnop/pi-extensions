# sub-agents

Spawns isolated child `pi` processes for delegated tasks.

## What it does

- `/handoff` — generates a continuation-ready handoff file from the current session using a dedicated agent.
- `/sub-agents` — opens a TUI to run agents manually in single/parallel/chain modes.
- Loads agent definitions from `.md` files in `cwd`, or falls back to built-in agents shipped with the extension.

## Commands

- `/handoff [short-title]` — summarize current session into a `handoff-<date>[-title].md` file.
- `/sub-agents` — open the sub-agents TUI.

## Important behaviors

- Each child process runs with `PI_SUB_AGENTS_CHILD=1`. The extension detects this and does **not** register its commands/tools inside children, preventing infinite recursion.
- Agent definitions are markdown files with YAML frontmatter. Fields: `name`, `description`, `model`, `tools`, `includeExtensions`, `extensions`, `timeoutMs`, `maxTurns`.
- Built-in agents: `scout-gemma`, `flash-worker`, `handoff-gemma`, `critic`.
- Handoff reads the current session branch via `ctx.sessionManager.getBranch()`, formats it, and asks a child agent to produce markdown.
- Child output is written to `cwd` as a markdown file.

## State

- `~/.pi/agent/settings.json` → `subAgents` (extension policies, default custom extensions, per-agent overrides).
- `~/.pi/agent/sub-agents-history/` — one JSON file per run.

## Dependencies

- Can spawn agents with arbitrary tool sets and extension sets. Default custom extensions for most agents include `grep-tool`, `pi-multi-edit`, `read-mode`, `simple-gate`.
- `handoff-gemma` runs with no extensions.

## Source

- `sub-agents/index.ts` — commands, handoff orchestration.
- `sub-agents/runner.ts` — child process spawning and result handling.
- `sub-agents/agents.ts` — agent/task discovery and frontmatter parsing.
- `sub-agents/tui.ts` — interactive TUI.
