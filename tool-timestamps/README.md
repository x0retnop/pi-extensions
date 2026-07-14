# tool-timestamps

TUI-only timeline of tool executions. Helps the user see *when* the agent did what. Never touches tool registration or LLM context.

## Install

Copy the extension folder to `~/.pi/agent/extensions/` and restart Pi.

## Two modes, picked automatically

### Inline mode (Pi >= 0.80.4, recommended)

Each finished tool call gets a dim row **right below it in the chat scrollback**:

```
07-14 21:34:47  read (1ms)
```

- Timestamp + tool + duration only. Target, result output, and exit codes are already shown by each tool's own renderer — repeating them makes noisy duplicates. Errors are marked `✗`.
- Implemented as persisted display-only session entries (`pi.appendEntry` + `pi.registerEntryRenderer`) — rendered in session order, restored on `/resume`, **never sent to the model**.
- Rows are stored in the session jsonl (small: stamp, tool, target, duration). Target is kept for `/timestamps all` but not shown inline.

### Widget fallback (Pi < 0.80.4)

A dim widget above the editor. `/timestamps` cycles `compact` (1 line) → `expanded` (8 rows) → `hidden`; `/timestamps on` / `off` jump directly.

### `/timestamps all` (both modes)

Scrollable list with every tool call of the session, oldest first (viewer: Enter/Esc closes). Built from a read-only scan of session messages, so it also covers sessions recorded before this extension existed.

## Design

- Data: `tool_execution_start` / `tool_execution_end` events (live) + `ctx.sessionManager.getEntries()` scan (list view).
- Rendering: entry renderer (inline) or keyed `setWidget` slot (fallback). No tools registered or overridden, nothing sent to the LLM. Silent in print/RPC mode (`ctx.hasUI === false`).
- Inline mode requires Pi >= 0.80.4 (`registerEntryRenderer`); detected at load, no version pinning needed.
