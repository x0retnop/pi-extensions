# Sub-Agents Extension: Agent Guide

This document describes the specialized subagents shipped with `pi-sub-agents`, how they are invoked, and how their system prompts are organized. It is intended both for users and for future prompt-engineering work.

## Overview

`pi-sub-agents` adds two slash commands (`/handoff`, `/sub-agents`) to Pi CLI. The extension spawns isolated child `pi` processes for manual work. Each child loads a single agent definition (a markdown file with YAML frontmatter) and runs one task. There is no agent-facing tool; everything is controlled by the user through the TUI.

There are four built-in agents:

| Agent | Purpose | Model | Tools | Extensions |
|---|---|---|---|---|
| `scout-gemma` | Fast read-only reconnaissance | local-llama/gemma-4-e4b-it-xl | read, grep, find, ls, bash | inherited from parent |
| `flash-worker` | Coding/refactoring tasks | opencode-go/deepseek-v4-flash | read, grep, find, ls, bash, edit, write | inherited from parent |
| `handoff-gemma` | Summarize current session into a handoff file | local-llama/gemma-4-e4b-it-xl | read | none (isolated) |
| `critic` | Review diffs or files for bugs, security, and maintainability | inherited from parent | read, grep, find, ls, bash | none (isolated) |

## How agents are loaded

Agents are discovered in this order:

1. `.md` files directly in the current working directory (`cwd`).
2. If none are found, built-in agents shipped inside the extension folder are used.

Each `.md` file contains YAML frontmatter followed by the system prompt body. See `README.md` for the full list of frontmatter fields.

## Agent system prompts

System prompts live in the agent definition files (`handoff-gemma.md`, `scout-gemma.md`, `flash-worker.md`) in the extension root. Each `.md` file contains YAML frontmatter followed by the system prompt body.

The prompts are structured into sections: Role, Responsibilities, Process, Output Structure, Tool Usage Rules, Quality Standards, Edge Cases, and Hard Constraints.

### Hard Constraints (present in all agents)

- Do not fabricate tool outputs or file contents.
- Do not invent file paths, line numbers, code snippets, or command results.
- If a tool fails or returns nothing, report that explicitly.

### Special guidelines

- `scout-gemma` is read-only and must never call `edit`/`write`.
- `scout-gemma` treats `{previous}` in a task as authoritative context and does not re-read sources already covered by it.
- `flash-worker` must read before editing, use exact `oldText`, batch edits, and run validation when requested.
- `handoff-gemma` uses only the provided session history and returns only markdown content.

## Extension isolation

Agents can control extensions via frontmatter:

- `includeExtensions: false` — child runs with no extensions.
- `includeExtensions: true` — child inherits all active parent extensions.
- `extensions: ext1, ext2` — child loads only the listed extensions (relative names resolve under `~/.pi/agent/extensions/`).

`handoff-gemma` uses `includeExtensions: false` because it only needs the built-in `read` tool.

## TUI

The `/sub-agents` slash command opens an interactive TUI for manual agent invocation. It supports single/parallel/chain modes, extension selection, CLI preview/copy, run history, and settings. Settings are stored in `~/.pi/agent/settings.json` under the `subAgents` key. History is stored as one JSON file per run in `~/.pi/agent/sub-agents-history/`.

## Testing notes

- `scout-gemma`: best for "find callers", "list files", "summarize module".
- `flash-worker`: best for small-to-medium edits, refactors, and adding safety fixes.
- `handoff-gemma`: best invoked via `/handoff [short-title]`.

When testing chain mode, explicitly instruct the downstream agent to treat `{previous}` as authoritative. This is now encoded in `scout-gemma.md`.
