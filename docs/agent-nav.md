# Agent Navigation — Lost? Start here

Quick index for agents working in this repo. If you are unsure where something lives, check the tables before guessing.

## "Where do I look for...?"

| I need to... | Go to |
|---|---|
| Critical rules and quick navigation | `AGENTS.md` |
| Dev vs runtime, copy rules, dependencies | `docs/pi-workflow.md` |
| API types, events, tool/command shapes | `docs/pi-quickref.md` |
| Where Pi's own `.d.ts` files live | `docs/pi-local-map.md` |
| Pi CLI update compatibility | Run `python scripts/check-pi-sync.py`, then `docs/pi-version-sync.md` |
| 0x010 backend control (start/stop/restart runtime) | `docs/0x010-control.md` |
| How extensions interact with each other and the runtime | `docs/interactions.md` |
| Git rules for this shared repo | `docs/git-policy.md` |
| Write a new extension | `docs/creating-extensions.md` |
| Copy-paste boilerplate | `docs/patterns.md` |
| Per-extension agent guide | `docs/extensions/<name>.md` |
| User-facing install/usage for an extension | `<extension>/README.md` |
| Currently active extensions | `~/.pi/agent/extensions/` (read-only unless asked) |
| Gate mode, workspace roots, protected paths | `~/.pi/agent/settings.json` (read-only unless asked) |
| Why a tool is missing or behaves oddly | `docs/pi-tool-internals.md`, then `docs/extensions/context-guard.md`, `docs/extensions/simple-gate.md` |
| Tool rendering pitfalls | `docs/tool-rendering.md` |
| Built-in tool limits (read truncation, bash output caps) | `docs/pi-local-map.md` → `dist/core/tools/truncate.js` |
| Built-in tool implementations | `dist/core/tools/*.js` inside Pi install (see `pi-local-map.md`) |
| Agent loop snapshot behavior | `docs/pi-tool-internals.md` §9 |
| Session log forensics | `scripts/pi_session_inspect.py` |

## "What should I remember every session?"

1. **Edit in dev, test after restart.** This repo is `C:/10x001/pi extensions/`. Pi runtime is `~/.pi/agent/extensions/`. Changes only apply after the user copies them and restarts Pi.
2. **Run `npm run typecheck`** before committing code or package changes.
3. **Do not edit `~/.pi/agent/`** unless explicitly asked.
4. **Agents do not manage extensions.** Enable/disable/copy/archive/create/delete extensions is the user's job.
5. **SYSTEM.md is empty.** Persona comes from `role-sw` and `~/.pi/agent/roles/`.
6. **AGENTS.md / CLAUDE.md** are auto-loaded from `cwd` and all ancestor directories. `context-guard` can strip ancestor files.

## "Which doc for which task?"

| Task | Doc |
|---|---|
| Fix a false block in the gate | `docs/extensions/simple-gate.md`, then `simple-gate/path-guard.ts` |
| Add a new command to an extension | `docs/pi-quickref.md` → "Registering a command" |
| Add a new tool to an extension | `docs/pi-quickref.md` → "Registering a tool" |
| Fix path classified as protected/outside project | `simple-gate/path-guard.ts` → `looksLikePath()` or `classifyPathAccess()` |
| Update roles or add a new role | `docs/extensions/role-sw.md`, then create a file in `~/.pi/agent/roles/` (user copies it) |
| Bump supported Pi CLI version | `docs/pi-version-sync.md` → follow the checklist |
| Fix a tool override bug | `docs/extensions/<name>.md` + `docs/pi-tool-internals.md` |
| Debug missing tools after session change | `docs/extensions/context-guard.md`, `docs/interactions.md` |
| Understand why system prompt looks different | `docs/extensions/context-guard.md` § prompt rules |

## Tool / LLM internals

| I need to... | Go to |
|---|---|
| Understand what tool fields are sent to the LLM | `docs/pi-tool-internals.md` |
| Check why a tool is active or inactive | `docs/pi-tool-internals.md` §5 |
| Understand when `pi.setActiveTools()` actually takes effect | `docs/pi-tool-internals.md` §9 |
| Inspect active vs registered tools | `/tools` and `/tools-all` (tool-dev extension) |
| Write a tool description that steers the LLM | `docs/pi-tool-internals.md` §7 |
