# Next Session Handoff — Agent Docs v2 + Tests

## Status

Picked up the handoff from the previous session. Docs were reviewed for accuracy, a lightweight unit-test runner was added, a bug in `pi-multi-edit` partialApply was caught and fixed by the new tests, 0x010 client mocks were added, and scripts/tests were consolidated and documented.

## Doc review findings

Spot-checked against source:

- `AGENTS.md` / `README.md` / `docs/agent-nav.md` — accurate, updated with 0x010 control and scripts tables.
- `docs/interactions.md` — event-handler registrations, tool overrides, `settings.json` consumers, and 0x010 backend wiring all match source. The runtime load-order note is still an assumption (based on `~/.pi/agent/extensions/` listing), but no conflicts found.
- `docs/extensions/simple-gate.md` — matches `path-guard.ts` and `index.ts`.
- `docs/extensions/context-guard.md` — toggle ids match `features.ts`; prompt-rule behavior matches `prompt-rules.ts`.
- `docs/extensions/pi-multi-edit.md` — matches tool registration and engine logic.
- `docs/extensions/pi-web-search.md`, `pi-project-memory.md`, `pi-session-memory.md` — URL resolution chains match source.
- `docs/extensions/model-manager.md` — matches `index.ts` behavior.

No TODO/FIXME markers in docs (only legitimate uses of the word "placeholder").

## Tests

Location: `tests/unit/` only. The old scratch files in `tests/` were removed.

Runner: `python scripts/run-tests.py [pattern]`

Tests:

- `tests/unit/simple-gate.test.ts` — `path-guard.ts` path normalization/classification and `decideBash` decision engine.
- `tests/unit/context-guard.test.ts` — `applyPromptRules` for date, cwd, agents, ancestorAgents, skills, roleOverride.
- `tests/unit/pi-multi-edit.test.ts` — single edit, batch edit, replaceAll, non-unique mismatch, atomic rollback, partialApply, multi-file batch.
- `tests/unit/0x010-client.test.ts` — HTTP mocks for `pi-web-search` status + MCP, `pi-project-memory` `apiPost`, and `pi-session-memory` search/content/status/list endpoints.

## Code changes for testability and fixes

- `simple-gate/index.ts`: `decideBash` now accepts a `Config` parameter instead of reading the module-level `CONFIG`. The tool-call handler passes `CONFIG` as before.
- `pi-multi-edit/engine.ts`: fixed `partialApply` so successful edits are actually written when one edit in the file fails; failed/skipped edits are reported separately.
- `pi-web-search/index.ts`, `pi-project-memory/index.ts`, `pi-session-memory/index.ts`: changed `BASE_URL` from `const` to `let` and exported `setBaseUrl()` so tests can point the clients at a local mock server without touching env vars or global fetch.
- Exported internal API helpers (`getBackendStatus`, `mcpCall`, `getMcpUrl`, `apiPost`, `apiSearch`, `apiSessionContent`, `apiStatus`, `apiRebuild`, `apiListSessions`) for testing.

## Scripts

Active scripts in `scripts/`:

- `scripts/run-tests.py` — compile and run `tests/unit/`.
- `scripts/check-pi-sync.py` — Pi CLI upgrade compatibility check.
- `scripts/pi_session_inspect.py` — session log forensics.

Removed: `scripts/parse_pi_session.py`, `scripts/parse_pi_session_simple.py` (legacy one-off converters; `pi_session_inspect.py` and `session_memory` cover the same needs).

`AGENTS.md` now has a short "Scripts" table explaining each.

## Docs added

- `docs/0x010-control.md` — how to start/stop/restart the 0x010 backend runtime via the Agent HTTP API (`127.0.0.1:18080`) and `task` shortcuts.
- Updated `docs/agent-nav.md` and `README.md` to link to the new control doc.

## How to run

```bash
# Type-check everything (tests are included in tsconfig)
npm run typecheck

# Run all unit tests
python scripts/run-tests.py

# Run a subset
python scripts/run-tests.py "*0x010*.js"

# Check Pi CLI sync
python scripts/check-pi-sync.py

# Session forensics
python scripts/pi_session_inspect.py --edit-errors --recent 20
```

## Still open / next time

- Consider adding a CI-style check that runs `npm run typecheck` and `python scripts/run-tests.py` before commits.
- The 0x010 backend control doc is intentionally short; expand it if new endpoints are added or if users need troubleshooting for embedding/main restarts.
- Test coverage for other extensions (`auto-trust`, `a-rewind`, `model-manager`, `read-mode`, `grep-tool`, `role-sw`, `sub-agents`) is still absent. Add only when touching their logic.

## Quick context reminders

- Edit in `C:/10x001/pi extensions/`. Runtime is `~/.pi/agent/extensions/`.
- Type-check code/package changes: `npm run typecheck`.
- Do not push; local commits only.
- Do not create/delete/archive extension folders unless asked.
