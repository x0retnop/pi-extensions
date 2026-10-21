# A Rewind

Session navigation helpers, a task timer, manual retry, pause/continue, and a prompt-cache keep-alive (`/warm`).

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
| `F4` (key) | Pause/resume toggle — same as `/pause` then `/continue`. |
| `/retry` | Continue the agent loop from the current session leaf after rewinding to a clean state. |
| `/warm` | Touch the provider prompt cache if idle is in the warm window (default 3m–4m45s). |
| `/warm status` | Show idle age, last settled clock, and whether the warm window is open. |

## Behavior

- Rewinding uses `ctx.navigateTree()`, which creates a branch without deleting history.
- On session resume, warns when the last leaf is an interrupted assistant message so you know to rewind before continuing. Also seeds the idle clock from the last assistant timestamp.
- `/pause` waits inside the `turn_start` handler, which the agent loop awaits before each LLM request. The freeze happens at a clean boundary: the previous assistant message and its tool results are already persisted and no HTTP stream is open. No history edits, no trigger messages. The current LLM response and its tool calls always finish first — pausing mid-stream or mid-tool is impossible.
- `F4` toggles: press while the agent is running to request a pause, press again while paused to resume (and while only *requested* to cancel it). It is a Pi extension shortcut (`pi.registerShortcut`), not a `keybindings.json` entry — `/keys` does not list it, `/hotkeys` does. Change it via `PAUSE_TOGGLE_KEY` in `index.ts`.
- `/retry` injects a hidden trigger message (`customType: "a-retry-trigger"`, `display: false`) and starts a turn; a `context` hook strips the trigger before it reaches the model. It refuses to run when the leaf is an interrupted (`aborted`/`error`) or tool-pending (`toolUse`) assistant message — rewind first.
- Task timer starts on `agent_start`, finishes on `agent_settled` (one notification per full run, including `/retry` and steering continuations), and excludes paused wall time. The status-bar timer **ticks every second** during a task (live count-up), not just at turn boundaries. Notify includes wall-clock end: `task time: 6m 29s · 65 tool calls · ended 14:32:05`.
- `/warm` is **manual only**. It fires only when idle is between **3m** and **4m45s** after the last `agent_settled` (too early = waste; too late = likely full prefix rebuild). Hidden `a-warm-trigger`; the “reply ok, no tools” cue is **this turn only** — later turns drop the trigger and the ping reply from LLM context. Still a real paid request against provider quota.
- **Session affinity** (automatic, free): every provider request gets sticky headers (`x-session-affinity`, `x-session-id` = Pi session id). OpenAI-shaped bodies also get `prompt_cache_key`. Improves cache routing; does not keep the cache alive by itself.

## Marker format

Internal hidden/filter markers intentionally use single-bracket strings such as `[a-rewind:...]`. Avoid changing them to double-bracket marker strings, because some harness/output paths may suppress those strings.

## Settings

No file-based settings. Use `/a-rewind-tt on|off|status` for the timer display. Constants live in `index.ts`: `WARM_MIN_IDLE_MS`, `WARM_MAX_IDLE_MS`, `PAUSE_TOGGLE_KEY`.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
