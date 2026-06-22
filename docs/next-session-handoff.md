# Next Session Handoff — Agent Docs v2 + Tests

## Status

Picked up the handoff from the previous session. Docs were reviewed for accuracy, a lightweight unit-test runner was added, and a bug in `pi-multi-edit` partialApply was caught and fixed by the new tests.

## Doc review findings

Spot-checked against source:

- `AGENTS.md` / `README.md` / `docs/agent-nav.md` — accurate, no changes needed.
- `docs/interactions.md` — event-handler registrations, tool overrides, `settings.json` consumers, and 0x010 backend wiring all match source. The runtime load-order note is still an assumption (based on `~/.pi/agent/extensions/` listing), but no conflicts found.
- `docs/extensions/simple-gate.md` — matches `path-guard.ts` and `index.ts`.
- `docs/extensions/context-guard.md` — toggle ids match `features.ts`; prompt-rule behavior matches `prompt-rules.ts`.
- `docs/extensions/pi-multi-edit.md` — matches tool registration and engine logic.
- `docs/extensions/pi-web-search.md`, `pi-project-memory.md`, `pi-session-memory.md` — URL resolution chains match source.
- `docs/extensions/model-manager.md` — matches `index.ts` behavior.

No TODO/FIXME markers in docs (only legitimate uses of the word "placeholder").

No doc changes were required. `docs/interactions.md` troubleshooting section looks sufficient for current active extensions.

## Tests added

Location: `tests/unit/` (the existing `tests/` directory was gitignored for scratch files; `.gitignore` was narrowed to allow `tests/unit/`).

Runner: `python scripts/run-tests.py`

What it does:

1. Compiles `tests/unit/**/*.test.ts` (and imported source modules) via `tsconfig.test.json` into `.tests-out/`.
2. Runs the compiled tests with `node --test`.

Tests written:

- `tests/unit/simple-gate.test.ts` — `path-guard.ts` path normalization/classification and `decideBash` decision engine.
- `tests/unit/context-guard.test.ts` — `applyPromptRules` for date, cwd, agents, ancestorAgents, skills, roleOverride.
- `tests/unit/pi-multi-edit.test.ts` — single edit, batch edit, replaceAll, non-unique mismatch, atomic rollback, partialApply, multi-file batch.
- `tests/unit/0x010-client.test.ts` — HTTP mocks for `pi-web-search` status + MCP, `pi-project-memory` `apiPost`, and `pi-session-memory` search/content/status/list endpoints.

## Code changes for testability and fixes

- `simple-gate/index.ts`: `decideBash` now accepts a `Config` parameter instead of reading the module-level `CONFIG`. The tool-call handler passes `CONFIG` as before.
- `pi-multi-edit/engine.ts`: fixed `partialApply` so successful edits are actually written when one edit in the file fails; failed/skipped edits are reported separately.
- `pi-web-search/index.ts`, `pi-project-memory/index.ts`, `pi-session-memory/index.ts`: changed `BASE_URL` from `const` to `let` and exported `setBaseUrl()` so tests can point the clients at a local mock server without touching env vars or global fetch.
- Exported internal API helpers (`getBackendStatus`, `mcpCall`, `getMcpUrl`, `apiPost`, `apiSearch`, `apiSessionContent`, `apiStatus`, `apiRebuild`, `apiListSessions`) for testing.

## Docs added

- `docs/0x010-control.md` — how to start/stop/restart the 0x010 backend runtime via the Agent HTTP API (`127.0.0.1:18080`) and `task` shortcuts.
- Updated `docs/agent-nav.md` and `README.md` to link to the new control doc.

## How to run

```bash
# Type-check everything (tests are included in tsconfig)
npm run typecheck

# Run unit tests
python scripts/run-tests.py
```

## Still open / next time

- `tests/` still contains old ad-hoc scratch files (`.md`, `large_test.ts`, etc.). They remain ignored; decide later whether to archive or delete them.
- Consider adding a CI-style check that runs `npm run typecheck` and `python scripts/run-tests.py` before commits.
- The 0x010 backend control doc is intentionally short; expand it if new endpoints are added or if users need troubleshooting for embedding/main restarts.

## Quick context reminders

- Edit in `C:/10x001/pi extensions/`. Runtime is `~/.pi/agent/extensions/`.
- Type-check code/package changes: `npm run typecheck`.
- Do not push; local commits only.
- Do not create/delete/archive extension folders unless asked.
