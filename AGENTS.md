# AGENTS.md

Quick context for agents working in this repo.

## What this is

This is a **development collection** of Pi Coding Agent extensions.
`C:/10x001/pi extensions/` is the dev workspace. The user edits and develops extensions here.

Active extensions are **manually copied** by the user to the Pi runtime folder:
`C:\Users\user\.pi\agent\extensions\` (or `~/.pi/agent/extensions/`).
They are **not** installed via `pi install`.

## Critical workflow rules

- **Edit here** (`C:/10x001/pi extensions/`).
- **Runtime is elsewhere** (`~/.pi/agent/extensions/`). Pi only loads from there.
- After editing, the user copies the folder manually and **restarts Pi**.
- Do **not** test freshly edited extensions via bash — they are not loaded yet.
- Do **not** edit `~/.pi/agent/extensions/` directly unless the user explicitly asks.

## Prompt & roles

- `~/.pi/agent/SYSTEM.md` is a **stub** (empty). Real persona comes from `role-sw`.
- Roles live in `~/.pi/agent/roles/` (`kimi.md`, `coding_agent.md`, etc.).
- `AGENTS.md` in this file is auto-loaded by Pi from cwd when launched from this directory.

## Checking Pi CLI version compatibility

When the user asks about upgrading Pi, version compatibility, or whether to update:

1. **First** run `python scripts/check-pi-sync.py` from the repo root.
2. **Then** read `docs/pi-version-sync.md` and follow its workflow.
3. **Only if** the script flags something or the CHANGELOG delta is unclear — use web search or fetch the full release notes for clarification.

**Do NOT start with web search.** The local script is the single source of truth for what is actually installed and what patterns exist in this collection.

## Runtime dependencies reminder

If you add a **new extension** or **new runtime dependency** to an existing extension:

1. Add the npm package to the extension's `package.json` `dependencies`.
2. After the user copies the extension to `~/.pi/agent/extensions/`, the dependency must be installed in the shared runtime:
   ```bash
   cd ~/.pi/agent
   npm install <package>
   ```
3. Do **not** create a `node_modules/` inside the extension folder.

Pi core packages (`@earendil-works/*`, `typebox`) are provided by Pi CLI at runtime — never list them as `dependencies`.

## Where to look

| If you need... | Look at... |
|---|---|
| Dev vs runtime rules, sync, dependencies | `docs/pi-workflow.md` |
| API types, events, UI | `docs/pi-quickref.md` |
| Providers, models, auth, adding custom models | `docs/pi-providers-models.md` |
| Where Pi types live locally | `docs/pi-local-map.md` |
| What to check after Pi CLI update | `docs/pi-version-sync.md` |
| Pi changelog / release notes | `https://pi.dev/changelog` |
| Create a new extension | `docs/creating-extensions.md` |
| Copy-paste snippets | `docs/patterns.md` |
| Current active extensions / settings | `~/.pi/agent/extensions/`, `~/.pi/agent/settings.json` |
| Custom tool rendering (renderCall / renderResult pitfalls) | `docs/tool-rendering.md` |

## Style

- One extension = one folder. Minimal, no frameworks.
- Keep `@earendil-works/*` as peer deps.
- Do not mass-format or rename without request.
