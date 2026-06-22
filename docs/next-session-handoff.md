# Next Session Handoff — Agent Docs v2 + Tests

## What was done

Completed the documentation reorganization planned in `docs/AGENTS-v2-outline.md`.

### Commits made

```
3186b03 [docs] rewrite agent docs: AGENTS.md, README.md, guides, interactions map
fa49d7e [docs] remove obsolete new-ext.md and archive permission-gate
a10cc5e [pi-web-search] refactor renderers to plain text helpers
ebcf42d [model-manager] add extension and include in tsconfig
```

### Files created/rewritten

- `AGENTS.md` — short root compass.
- `README.md` — dev collection overview.
- `docs/agent-nav.md` — updated index.
- `docs/git-policy.md` — simple local git rules for agents.
- `docs/interactions.md` — cross-extension/runtime wiring map + conflicts + troubleshooting.
- `docs/extensions/<name>.md` — per-extension agent guides for all 13 active extensions.
- `pi-project-memory/AGENTS.md`, `pi-session-memory/AGENTS.md`, `sub-agents/AGENTS.md` — normalized to extension-only templates.
- `docs/patterns.md`, `docs/creating-extensions.md` — trimmed/updated.
- `docs/archive/permission-gate.md` — archived deprecated doc.

### Other

- `model-manager/` was already present in the working tree; committed as part of this work.
- `pi-web-search/index.ts` had uncommitted renderer refactor; committed as part of this work.
- `new-ext.md` deleted, `docs/permission-gate.md` moved to archive.

## Goals for next session

1. **Review and verify** the new docs for accuracy and gaps.
   - Read `AGENTS.md`, `README.md`, `docs/interactions.md`.
   - Spot-check a few `docs/extensions/<name>.md` against source.
   - Check if any extension behavior changed recently and docs are stale.

2. **Identify missing or unclear sections** and fix them.
   - Any TODOs or placeholder notes in docs?
   - Any extension interactions not covered?
   - Is the troubleshooting section in `interactions.md` sufficient?

3. **Design tests for extensions**.
   - Decide test runner and location (`tests/` vs `scripts/tests/`).
   - Candidate targets:
     - `simple-gate` path classification + decision engine.
     - `context-guard` prompt-rule transformations.
     - `pi-multi-edit` edit batching and partialApply.
     - 0x010 client mocks for `pi-web-search`, `pi-project-memory`, `pi-session-memory`.
   - Keep tests lightweight; no heavy framework unless needed.
   - Add a simple command to run them, e.g. `python scripts/run-tests.py`.

4. **Commit follow-ups** using the same simple prefix convention.

## Quick context reminders

- Edit in `C:/10x001/pi extensions/`. Runtime is `~/.pi/agent/extensions/`.
- Type-check code/package changes: `npm run typecheck`.
- Do not push; local commits only.
- Do not create/delete/archive extension folders unless asked.
