# context-compressor

Lightweight, transparent context compression for long autonomous sessions.

## What it does

- Monitors context usage and agent step count before each LLM call (`context` event).
- Triggers a separate same-model summarization call when:
  - context usage exceeds `tokenThresholdPercent` (default 55%), or
  - `stepInterval` LLM calls have passed since the last summary.
- Injects a compact `**KEY FACTS**` memory block into the current message list.
- Leaves the original system prompt untouched.
- Falls back gracefully if summarization fails.

## Files

- `index.ts` — main extension wiring.
- `config.ts` — settings persistence in `~/.pi/agent/settings.json` under `contextCompressor`.
- `types.ts` — settings and runtime state types.
- `compressor.ts` — summarization, injection, and message trimming.
- `tui.ts` — interactive `/context-compressor` menu.
- `prompt-balanced.txt` — detailed KEY FACTS prompt.
- `prompt-minimal.txt` — compact bullet prompt.

Prompt files are read **only** from the same directory as `index.ts`; no search elsewhere.

## Commands

- `/context-compressor` — open the interactive TUI.
- `/context-compressor status` — print current settings and runtime state.

## Settings

| Setting | Default | Description |
|---|---|---|
| `enabled` | `true` | Master toggle. |
| `promptName` | `"balanced"` | Which `prompt-<name>.txt` to use. |
| `mode` | `"auto"` | `"auto"` triggers on thresholds; `"manual"` only injects existing KEY FACTS. |
| `tokenThresholdPercent` | `55` | Context usage % that triggers summarization. |
| `stepInterval` | `10` | Trigger every N LLM calls. |
| `minMessagesToSummarize` | `6` | Minimum conversation messages before summarizing. |
| `maxSummaryTokens` | `2000` | Max tokens for the summary output. |
| `trimAfterCompress` | `false` | Drop older messages, keeping only recent ones + KEY FACTS. |
| `keptRecentMessages` | `8` | How many messages to keep when trimming. |
| `debug` | `false` | Log compression attempts/failures to stderr. |

## Behavior notes

- Summarization uses the currently active model (`ctx.model`) via `completeSimple` from `@earendil-works/pi-ai`, preserving the agent's reasoning style.
- The summarization call runs inside the `context` event and blocks the main LLM call until it completes.
- KEY FACTS are injected as a `custom` message with `customType: "context-compressor"`. It is converted to a user-facing message for the LLM.
- Runtime state is per-session and in-memory; it resets on `session_start`.
- Built-in compaction resets compression tracking so the extension does not immediately re-trigger.
