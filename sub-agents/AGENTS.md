# sub-agents — Agent Guide

> Loaded together with the root `AGENTS.md`. This file contains only guidance specific to `sub-agents`.

## What this is

Spawns isolated child `pi` processes for delegated tasks. No agent-facing tools; everything is controlled through slash commands and TUI.

## Commands

- `/handoff [short-title]` — generate a continuation-ready handoff file from the current session.
- `/sub-agents` — open the TUI for manual agent invocation.

## Built-in agents

| Agent | Purpose | Tools | Extensions |
|---|---|---|---|
| `scout-gemma` | Read-only reconnaissance | read, grep, find, ls, bash | `grep-tool`, `read-mode` |
| `flash-worker` | Coding/refactoring | read, grep, find, ls, bash, edit, write | `grep-tool`, `pi-multi-edit`, `read-mode`, `simple-gate` |
| `handoff-gemma` | Summarize session into handoff file | read | none |
| `critic` | Review diffs/files | read, grep, find, ls, bash | none |

## Important behaviors

- The extension does not register itself inside child processes (`PI_SUB_AGENTS_CHILD=1`).
- Agent definitions are markdown files with YAML frontmatter in `cwd` or built-in.
- Child extension sets are configured in `~/.pi/agent/settings.json` under `subAgents`.

## Source

- `sub-agents/index.ts` — commands and handoff orchestration.
- `sub-agents/runner.ts` — child process spawning.
- `sub-agents/agents.ts` — agent discovery.
