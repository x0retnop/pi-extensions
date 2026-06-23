# AGENTS.md

You are working in the **dev workspace** for Pi Coding Agent extensions.

## Critical rules

- Edit in `C:/10x001/pi extensions/`. Runtime is `~/.pi/agent/extensions/`.
- After code changes, the user copies the extension and **restarts Pi**. Do not test fresh code via bash.
- Do not edit `~/.pi/agent/extensions/` or `~/.pi/agent/settings.json` unless explicitly asked.
- Run `npm run typecheck` from the repo root before committing code or package changes.
- `@earendil-works/*` and `typebox` are `peerDependencies`. Normal npm deps are installed in `~/.pi/agent/`.
- **Do not enable, disable, copy, archive, delete, or create extensions.** That is the user's job.
- Agents manage git locally: small prefixed commits, no push, no rebase. See `docs/git-policy.md`.

## When unsure, follow this order

1. Check the table below or `docs/agent-nav.md`.
2. Read `docs/extensions/<name>.md` for the relevant extension.
3. Read the extension source `index.ts`.
4. Only then search the web.

## Where to look

| Need | Look at |
|------|---------|
| Dev vs runtime / sync / deps | `docs/pi-workflow.md` |
| Pi CLI upgrade compatibility | Run `python scripts/check-pi-sync.py`, then `docs/pi-version-sync.md` |
| API types, events, tool/command shapes | `docs/pi-quickref.md`, `docs/pi-local-map.md` |
| Tool missing or behaving oddly | `docs/pi-tool-internals.md`, `docs/extensions/context-guard.md`, `docs/extensions/simple-gate.md` |
| Per-extension behavior | `docs/extensions/<name>.md` |
| Cross-extension wiring | `docs/interactions.md` |
| Git rules | `docs/git-policy.md` |
| Session log forensics | `scripts/pi_session_inspect.py` |

## Quick context

- `AGENTS.md` / `CLAUDE.md` files in `cwd` and all ancestors are auto-injected. `context-guard` can strip ancestor files.
- `SYSTEM.md` is empty; persona comes from `role-sw` (`~/.pi/agent/roles/`).
- Several extensions override built-in tools: `read-mode` (read), `pi-multi-edit` (edit), `grep-tool` (grep).
- `context-guard` can strip system-prompt parts and toggle tools. `simple-gate` can block/ask `read/write/edit/bash`.
- Three extensions share the 0x010 backend: `pi-web-search`, `pi-project-memory`, `pi-session-memory`.
- `pi-project-memory` requires `.project-id` in `cwd`.

## Scripts (what we keep in this repo)

| Script | Purpose | When to run |
|--------|---------|-------------|
| `scripts/run-tests.py` | Compile and run the unit-test suite (`tests/unit/`). | After code changes, before commits that touch logic. |
| `scripts/check-pi-sync.py` | Compare installed Pi CLI version with upstream CHANGELOG and scan local code for obsolete API patterns. | After `pi` CLI updates or before risky refactors. |
| `scripts/pi_session_inspect.py` | Forensics on `~/.pi/agent/sessions/*.jsonl`: tool-call counts, errors, edit failures. | Debugging why a tool failed or auditing recent sessions. |
| `scripts/pi-session-compressor-tune.py` | Analyze Pi sessions and suggest tuned `context-compressor` settings. | After installing `context-compressor` or when tuning compression thresholds. |

## Style

- One extension = one folder. Minimal, no frameworks.
- Keep changes reviewable; do not mass-format or rename without request.
