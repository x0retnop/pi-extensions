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
- `/pause` — freeze the agent loop at the next turn boundary. Can be typed while the agent is streaming (extension commands execute immediately mid-stream).
- `/continue` — resume a loop frozen by `/pause`; cancels a pending `/pause` request if the boundary has not been reached yet.
- `/retry` — trigger the next agent turn from the current leaf.  
  **Guards:**
  - If the leaf is an `assistant` with `stopReason: "aborted"` or `"error"`, it refuses and tells you to rewind first.
  - If the leaf is an `assistant` with `stopReason: "toolUse"`, it refuses and tells you to rewind first (tool results are missing).
  - If the leaf is an `assistant` with `stopReason: "stop"`, it tells you the turn is already complete.
  - Otherwise it injects a hidden trigger message (`display: false`) and starts the turn.

## Important behaviors

- Rewinding uses `ctx.navigateTree()`, which creates a branch without deleting history.
- Task timing is purely informational; it does not affect session logic. The timer starts on `agent_start` (guarded, so mid-run continuations do not restart it) and finishes on `agent_settled`, which fires once per full run — this covers `/retry` runs and steering/follow-up continuations, which never emit `before_agent_start`. Paused wall time is excluded from the timer.
- `/pause` waits inside the `turn_start` handler, which the agent loop awaits before each LLM request. At that point the previous assistant message and all its tool results are already persisted and no HTTP stream is open, so the freeze is clean: no history edits, no trigger messages. The wait resolves on `/continue`, on abort (Esc), or on session shutdown. Limits: the current LLM response and its tool calls (including a long bash) always finish first — pausing mid-stream or mid-tool is impossible by design.
- While paused, commands that await `waitForIdle()` (`/a-rewind*`, `/retry`) block until `/continue` — resume first.
- `/retry` uses `pi.sendMessage(..., { triggerTurn: true })` with a hidden trigger message (`customType: "a-retry-trigger"`, `display: false`). A `context` hook strips the trigger before it reaches the LLM, so the model sees the same conversation it would have seen without `/retry`. If stripping ever leaves the context ending on an `assistant` message, a minimal empty `user` placeholder is appended to preserve role alternation.
- **Never inject massive text through `pi.sendMessage` or `pi.sendUserMessage` in a single call.** Large messages (>~8 KB) can corrupt the session JSONL or overflow context, causing model degradation (text-only responses instead of tool calls). Write large files via `bash` with a heredoc or `write` tool instead.

## Source

- `a-rewind/index.ts`
