# a-rewind

Session navigation helpers and a basic task timer.

## What it does

- Lets the user rewind the session tree to before the latest assistant message, to the latest user message, or one step back.
- Shows task duration in the status bar and notifies after each turn.

## Commands

- `/a-rewind` — rewind to before the latest assistant message.
- `/a-rewind-step` — undo the latest session entry.
- `/a-rewind-user` — rewind to the latest user message (undo all agent actions after it).
- `/a-rewind-tt [on|off|status]` — toggle the task timer display.

## Important behaviors

- Rewinding uses `ctx.navigateTree()`, which creates a branch without deleting history.
- Task timing is purely informational; it does not affect session logic.

## Source

- `a-rewind/index.ts`
