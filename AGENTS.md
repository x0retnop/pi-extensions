# AGENTS.md

Quick context for agents in this repo.

## What this is

Dev collection of **Pi Coding Agent** extensions. Each top-level folder with `package.json` is a standalone package installable via `pi install ./folder`.

## Critical workflow rule

- **Edit here** (`C:/10x001/pi extensions/`).
- **Runtime is elsewhere** (`~/.pi/agent/extensions/`). Pi only loads from there.
- After editing, the user copies the folder manually and **restarts Pi**.
- **Do not test freshly edited extensions via bash** — they are not loaded yet.
- **Do not edit `~/.pi/agent/extensions/` directly** unless the user explicitly asks.

## Prompt & roles

- `~/.pi/agent/SYSTEM.md` is a **stub** (empty). Real persona comes from `role-sw`.
- Roles live in `~/.pi/agent/roles/` (`kimi.md`, `coding_agent.md`, etc.).
- `AGENTS.md` in this file is auto-loaded by Pi from cwd when launched from this directory.

## Where to look

| If you need... | Look at... |
|---|---|
| Dev vs runtime rules, sync, dependencies | `docs/pi-workflow.md` |
| API types, events, UI | `docs/pi-quickref.md` |
| Where Pi types live locally | `docs/pi-local-map.md` |
| What to check after Pi CLI update | `docs/pi-version-sync.md` |
| Pi changelog / release notes | `https://pi.dev/changelog` |
| Create a new extension | `docs/creating-extensions.md` |
| Copy-paste snippets | `docs/patterns.md` |
| Current active extensions / settings | `~/.pi/agent/extensions/`, `~/.pi/agent/settings.json` |

## Style

- One extension = one folder. Minimal, no frameworks.
- Keep `@earendil-works/*` as peer deps.
- Do not mass-format or rename without request.
