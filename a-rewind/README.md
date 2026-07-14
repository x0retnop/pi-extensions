# A Rewind

Session navigation helpers, a task timer, a manual retry command for resuming interrupted sessions, and a pause/continue pair that freezes the agent loop at a turn boundary.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-a-rewind
```

## Commands

| Command | Description |
| --- | --- |
| `/a-rewind` | Rewind the current session to before the latest assistant message. |
| `/a-rewind-step` | Rewind the session one step back (undo the latest entry). |
| `/a-rewind-user` | Rewind to the latest user message (undo all agent actions after it). |
| `/a-rewind-tt [on\|off\|status]` | Toggle the task timer display in the status bar. |
| `/pause` | Freeze the agent loop at the next turn boundary. Works while the agent is streaming. |
| `/continue` | Resume a loop frozen by `/pause` (or cancel a pending pause request). |
| `/retry` | Continue the agent loop from the current session leaf after rewinding to a clean state. |

## Behavior

- Rewinding uses `ctx.navigateTree()`, which creates a branch without deleting history.
- On session resume, warns when the last leaf is an interrupted assistant message so you know to rewind before continuing.
- `/pause` waits inside the `turn_start` handler, which the agent loop awaits before each LLM request. The freeze happens at a clean boundary: the previous assistant message and its tool results are already persisted and no HTTP stream is open. No history edits, no trigger messages. The current LLM response and its tool calls always finish first — pausing mid-stream or mid-tool is impossible.
- `/retry` injects a hidden trigger message (`customType: "a-retry-trigger"`, `display: false`) and starts a turn; a `context` hook strips the trigger before it reaches the model. It refuses to run when the leaf is an interrupted (`aborted`/`error`) or tool-pending (`toolUse`) assistant message — rewind first.
- Task timer starts on `agent_start`, finishes on `agent_settled` (one notification per full run, including `/retry` and steering continuations), and excludes paused wall time.

## Marker format

Internal hidden/filter markers intentionally use single-bracket strings such as `[a-rewind:...]`. Avoid changing them to double-bracket marker strings, because some harness/output paths may suppress those strings.

## Settings

No file-based settings. Use `/a-rewind-tt on|off|status` for the timer display.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
