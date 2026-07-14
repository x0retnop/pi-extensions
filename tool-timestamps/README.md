# tool-timestamps

TUI-only timeline of tool executions, shown as a dim widget above the editor. Helps the user see *when* the agent did what. Never touches tool registration, session files, or LLM context.

## Install

Copy the extension folder to `~/.pi/agent/extensions/` and restart Pi.

## What you see

```
07-14 15:32:01  bash (2.3s)  npm test
07-14 15:32:05  read  src/index.ts
07-14 15:32:07  ✗ grep  TODO
```

- One row per finished tool call, last 8 shown (TUI widget cap is 10 lines).
- Live calls include duration; errors are marked with `✗`.
- On startup / `/resume` / `/new` / `/fork` the timeline is rebuilt read-only from session entries (timestamps are stored on every message, durations are not — so history rows show time only).

## Design

- Data sources: `session_start` entry scan (`ctx.sessionManager.getEntries()`) + `tool_execution_start` / `tool_execution_end` events.
- Rendering: `ctx.ui.setWidget("tool-timestamps", ...)`, keyed slot — no conflict with other extensions.
- No tools registered or overridden, nothing persisted, nothing sent to the LLM. Silent in print/RPC mode (`ctx.hasUI === false`).
