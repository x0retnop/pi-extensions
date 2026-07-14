# tool-timestamps

TUI-only timeline of tool executions, shown as a dim widget above the editor. Helps the user see *when* the agent did what. Never touches tool registration, session files, or LLM context.

## Install

Copy the extension folder to `~/.pi/agent/extensions/` and restart Pi.

## Modes (`/timestamps` cycles)

- **compact** (default) — one line: `18:17:38  bash (119ms)  ls "/c/..."  ·  24 events`
- **expanded** — up to 8 recent rows
- **hidden** — widget removed

`/timestamps all` — scrollable list with every event of the session (viewer: Enter/Esc closes). `/timestamps on` / `off` — jump to compact / hidden.

Row format: `MM-DD HH:MM:SS  tool (duration)  target`. Live calls include duration; errors are marked with `✗`. On startup / `/resume` / `/new` / `/fork` the timeline is rebuilt read-only from session entries (timestamps are stored on every message, durations are not — so history rows show time only).

## Why a widget and not inline timestamps in the chat scrollback

Everything in the scrollback is owned by the individual tool renderers. The only extension hook that injects rows there (custom messages) is also sent to the LLM. A keyed `setWidget` slot is the only zero-conflict, zero-LLM-impact surface — correlation with the scrollback is by row order and target text (use `/timestamps all`).

## Design

- Data sources: `session_start` entry scan (`ctx.sessionManager.getEntries()`) + `tool_execution_start` / `tool_execution_end` events.
- Rendering: `ctx.ui.setWidget("tool-timestamps", ...)`; list view: `ctx.ui.select(...)`.
- No tools registered or overridden, nothing persisted, nothing sent to the LLM. Silent in print/RPC mode (`ctx.hasUI === false`).
