<!-- LLM-only. Stable facts, under ~80 lines. Fix what becomes wrong; never expand for completeness. -->

# Pi Extensions — Agent Guide

Dev workspace for Pi Coding Agent extensions. Code is edited here; the user copies it to the runtime (`~/.pi/agent/extensions/`) and restarts Pi — fresh code cannot be tested via bash.

## Start here

1. `docs/pi-workflow.md` — dev/runtime model, dependency rules, sync checklist.
2. `npm run typecheck` from the repo root verifies the environment works.
3. Read docs only when the task touches their area (table below).

This file is a shortcut, not a mirror — if it does not answer a question, explore the repo; the code is the source of truth.

## Map

| Area | Path | Notes |
|---|---|---|
| Extensions | `<name>/` | one folder = one extension, flat; entry `<name>/index.ts` |
| Shared TS helpers | `common/` | imported by extensions; not an extension itself |
| Skills, themes | `skills/`, `themes/` | dev copies, synced manually to `~/.pi/agent/` |
| Unit tests | `tests/unit/` | run via `python scripts/run-tests.py` |
| Scripts | `scripts/` | test runner, Pi version check, session forensics |
| Archived extensions | `Inactive/` | zips only, not loadable; their docs carry an "archived" banner |

Do not scan: `node_modules/`, `.tests-out/`, `Inactive/`, `mcps/` — open a file there only if the user names it.

## Commands

```bash
# run from repo root
npm run typecheck                # before committing code/package changes
python scripts/run-tests.py      # unit tests (tests/unit/)
python scripts/check-pi-sync.py  # after a Pi CLI update, before version refactors
python scripts/pi_session_inspect.py --summary --since 7   # session-log forensics
```

## Rules

- Edit only inside this repo. Never edit `~/.pi/agent/` (extensions, settings) unless explicitly asked.
- Never enable, disable, copy, archive, or delete extensions — deploy and lifecycle are the user's job.
- `@earendil-works/*` and `typebox` stay `peerDependencies` with `"*"`; regular npm deps install in `~/.pi/agent/`, never in extension folders.
- Do not mass-format or rename without request.

## Docs

| Doc | Read when |
|---|---|
| `docs/pi-workflow.md` | dev vs runtime, deps, sync checklist |
| `docs/pi-version-sync.md` | Pi CLI upgrade compatibility (run `check-pi-sync.py` first) |
| `docs/pi-quickref.md` | ExtensionAPI events/tools/commands reference |
| `docs/pi-local-map.md` | where Pi's installed source, types, and shipped docs live |
| `docs/pi-tool-internals.md` | tool visibility, what reaches the LLM, `setActiveTools()` timing |
| `docs/pi-internals.md` | system-prompt construction, message flow, retry, pitfalls |
| `docs/tool-rendering.md` | renderCall/renderResult pitfalls; battle-tested lessons |
| `docs/interactions.md` | cross-extension wiring, tool overrides, load order, troubleshooting |
| `docs/creating-extensions.md`, `docs/patterns.md` | new-extension scaffold, copy-paste snippets |
| `docs/pi-network-runtime.md` | proxy/VPN/timeout diagnosis |
| `docs/pi-providers-models.md`, `docs/pi-kimi-coding.md` | models.json, custom providers, Kimi setup |
| `docs/0x010-control.md` | start/stop the local 0x010 backend (web-search, *-memory) |
| `docs/pi-skill-craft.md` | writing skills for context-guard `/use-skill` |
| `docs/scripts/pi_session_inspect.md` | forensics script options |
| `docs/extensions/<name>.md` | per-extension behavior (archived ones say so) |
| `docs/model-context/kimi-k2/` | why pi-multi-edit is shaped this way (K2 training-gap research) |

Doc rules: English, LLM-only, lead with the non-obvious fact. If a doc contradicts the code, the code wins — fix or delete the doc right then. No STATUS/TODO/handoff files; work state lives in commit messages.

## Quick context

- Pi auto-injects `AGENTS.md`/`CLAUDE.md` from cwd and all ancestors; `context-guard` can strip ancestor files.
- `SYSTEM.md` is empty; persona comes from `role-sw` (`~/.pi/agent/roles/`).
- Tool overrides: `read-mode` → `read`, `pi-multi-edit` → `edit` (+ `multi_edit`, `insert`), `grep-tool` → `grep`. `simple-gate` can block/ask `read/write/edit/bash`.
- `pi-web-search`, `pi-project-memory`, `pi-session-memory` share the 0x010 backend (`127.0.0.1:8000`); `pi-project-memory` requires `.project-id` in cwd.

## Git

Agent-owned local memory: commit after a verified chunk; never push, no remotes, no rebase/amend/reset.

- Message prefix = area: `[root]`, `[docs]`, `[scripts]`, `[<ext>]`. Details: `docs/git-policy.md`.
- Never commit `node_modules/`, zips, logs, or temp files — keep `.gitignore` current.
