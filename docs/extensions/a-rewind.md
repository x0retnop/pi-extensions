# a-rewind

Session navigation helpers, a basic task timer, and a manual retry command for resuming interrupted sessions.

## What it does

- Lets the user rewind the session tree to before the latest assistant message, to the latest user message, or one step back.
- Shows task duration in the status bar and notifies after each turn.
- On `session_start` with `reason === "resume"`, warns if the last leaf is an interrupted assistant message (`aborted`, `error`, or `toolUse` without results) so the user knows they may need to rewind.
- Provides `/retry` to continue the agent loop from the current leaf after the user has rewound to a clean state.

## Commands

- `/a-rewind` — rewind to before the latest assistant message.
- `/a-rewind-step` — undo the latest session entry.
- `/a-rewind-user` — rewind to the latest user message (undo all agent actions after it).
- `/a-rewind-tt [on|off|status]` — toggle the task timer display.
- `/retry` — trigger the next agent turn from the current leaf.  
  **Guards:**
  - If the leaf is an `assistant` with `stopReason: "aborted"` or `"error"`, it refuses and tells you to rewind first.
  - If the leaf is an `assistant` with `stopReason: "toolUse"`, it refuses and tells you to rewind first (tool results are missing).
  - If the leaf is an `assistant` with `stopReason: "stop"`, it tells you the turn is already complete.
  - Otherwise it injects a hidden trigger message (`display: false`) and starts the turn.

## Important behaviors

- Rewinding uses `ctx.navigateTree()`, which creates a branch without deleting history.
- Task timing is purely informational; it does not affect session logic.
- `/retry` uses `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`. The trigger message has `display: false`, so it is invisible in the TUI, but it still enters the LLM context as an empty user message (all custom messages convert to `role: "user"`).

## Source

- `a-rewind/index.ts`
