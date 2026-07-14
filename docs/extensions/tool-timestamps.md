# tool-timestamps

TUI-only timeline of tool executions. Never touches tool registration or LLM context.

## Behavior

Two mutually exclusive rendering paths, auto-detected at load:

| Pi version | Path | What the user sees |
|---|---|---|
| >= 0.80.4 | **Inline entries** | Dim row directly under each tool call in the scrollback: `MM-DD HH:MM:SS  tool (dur)`. Nothing else — target/output are already shown by each tool's own renderer. Errors marked `✗`. |
| < 0.80.4 | **Widget fallback** | Keyed `setWidget` slot above the editor. `/timestamps` cycles compact (1 line) → expanded (8 rows) → hidden. |

Both: `/timestamps all` — scrollable full session list (oldest first), built from a read-only scan of session messages, works for any session including pre-extension ones.

## Key mechanics

- Inline rows are **persisted custom entries** (`pi.appendEntry("tool-timestamp", row)` on `tool_execution_end`) + `pi.registerEntryRenderer`. They render in session order, survive `/resume`, and are ignored by `buildSessionContext` (never sent to the model).
- **Backfill limitation:** rows exist only for tool calls executed while the extension was active. Appending entries on `/resume` of an old session would misplace them at the end of the transcript, so old sessions show inline rows only for new calls. The `/timestamps all` list view is the way to inspect old sessions.
- Live duration comes from `tool_execution_start`/`tool_execution_end` pairing by `toolCallId`. History rows (list view) have no duration — sessions store timestamps, not durations.
- `registerEntryRenderer` detection is a runtime typeof check (repo type deps may lag); widget fallback is compiled in but inert on new Pi.

## Interactions

- None. No tools registered or overridden, no session writes besides its own `custom` entries, silent when `ctx.hasUI === false`.
