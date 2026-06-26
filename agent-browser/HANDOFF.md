# Handoff: agent-browser redesign in progress

## What we are doing

Redesigning the `agent-browser` Pi extension so it is **universal, agent-friendly, and less manual**. Goal: remove repetitive coordination (cdp_url on every call, separate wait calls, stale @eN refs, guessing selectors for text extraction).

## Current state of the repo

- `agent-browser/tools/help.ts` — deleted.
- `agent-browser/types.ts` — extended `AgentBrowserState` with optional `cdpUrl` and `lastSnapshot`.
- `agent-browser/config.ts` — updated to persist/restore `cdpUrl` and `lastSnapshot`.
- `agent-browser/skills/core.md` — rewritten: no `browser_help`, auto-CDP, auto-waits, `action:text`, `action:submit`.
- `agent-browser/skills/network.md`, `state.md`, `debug.md` — updated, help references removed.
- `agent-browser/tools/browser.ts` — partially rewritten to a factory `createBrowserToolDefinition(pi)` with:
  - session-cached `cdpUrl`;
  - `@eN` fallback to `aria-label` / visible text from cached snapshot;
  - new actions `text` and `submit`;
  - default `wait_after:networkidle` for navigation actions;
  - snapshot output cached for fallback lookups.
- `agent-browser/tools/network.ts`, `state.ts`, `debug.ts` — converted to factories accepting `pi`, auto-CDP from session.
- `agent-browser/index.ts` — updated to call the factory functions.

## Typecheck status

`npm run typecheck` currently fails on:

- `agent-browser/tools/debug.ts` — needs conversion to `createDebugToolDefinition(pi)` and use `pi.appendEntry` instead of `ctx.sessionManager.appendEntry`.
- `agent-browser/tools/state.ts` — already converted in the working tree but may still have stale imports/statements.
- `agent-browser/tools/network.ts` — already converted in the working tree but may still have stale imports/statements.

Next agent should run `npm run typecheck` and fix any remaining TS errors.

## Next steps for the next session

1. Run `npm run typecheck`.
2. Finish converting `debug.ts` to factory pattern (mirroring network/state).
3. Verify `index.ts` imports and registers all four factory functions:
   - `createBrowserToolDefinition(pi)`
   - `createNetworkToolDefinition(pi)`
   - `createStateToolDefinition(pi)`
   - `createDebugToolDefinition(pi)`
4. Run `python scripts/run-tests.py`.
5. Live-test in Pi with the user's copy-paste prompt + `agent-browser/skills/core.md`.
6. Iterate based on the live test.

## Key design decisions already made

- No `browser_help` tool; user copy-pastes a short prompt + skill path.
- `cdp_url` is remembered per session after first use.
- Navigation actions auto-wait `networkidle` by default.
- `@eN` refs auto-fallback to `aria-label` / text from the last snapshot.
- `browser action:text` reads visible page text.
- `browser action:submit` does fill + click send button in one call.

## Files most likely to need attention

- `agent-browser/tools/debug.ts`
- `agent-browser/index.ts`
- `agent-browser/tools/browser.ts` (test fallback logic, especially `findSendButtonSelector` and `resolveSelector`)

## How to continue

1. Read this file.
2. Run `npm run typecheck`.
3. Fix remaining compile errors.
4. Run tests.
5. Ask the user for a live test or run one if requested.
