# a-rewind

Session navigation helpers, a basic task timer, manual retry, pause/continue, and a prompt-cache keep-alive (`/warm`).

## What it does

- Lets the user rewind the session tree to before the latest assistant message, to the latest user message, or one step back.
- Shows task duration in the status bar and notifies after each turn, including the number of tool calls and the **wall-clock end time**.
- On `session_start` with `reason === "resume"`, warns if the last leaf is an interrupted assistant message (`aborted`, `error`, or `toolUse` without results) so the user knows they may need to rewind. Also seeds the idle clock from the last assistant timestamp so `/warm` works after resume.
- Provides `/retry` to continue the agent loop from the current leaf after the user has rewound to a clean state.
- **Auto-continues** a turn that died on a transient provider error: once Pi's own retry budget is spent, a hidden retry trigger fires on a 30 s / 60 s / 120 s ladder (3 attempts). Deterministic errors (quota, auth, invalid request, context overflow) are left to fail loudly — the same request would earn the same answer.
- Provides `/warm` to re-touch the provider prompt cache while idle is still in a cheap window (default **3m–4m45s**).
- Injects **session affinity** on every provider request (free sticky routing for prompt cache — not a keep-alive).

## Non-obvious

- **`F4`** — one-key toggle for the whole pause cycle: request → paused → resumed. Registered with `pi.registerShortcut`, so it lives in **no config file**: `/keys` cannot see or rebind it, `/hotkeys` lists it. Move it by editing `PAUSE_TOGGLE_KEY` in `a-rewind/index.ts` (`f1`–`f12` and modifier chords both work), rebuild, restart Pi. Pi refuses to load the shortcut if its key is taken by a *reserved* built-in binding (Esc, Ctrl+C, Ctrl+D, Shift+Tab, Ctrl+O, Ctrl+T, Ctrl+G, Ctrl+X, Ctrl+Q, Enter, Ctrl+K) — picked `F4` because nothing uses it (model-manager already owns `F2`/`F3`).
- **`/retry` guards are checked against the last *message* in the branch, not the leaf** — after a rewind the leaf is the `a-rewind` label entry, so leaf-based checks would never fire:
  - last message is an `assistant` with `stopReason: "aborted"` or `"error"` → refuses, rewind first;
  - `stopReason: "toolUse"` → refuses (tool results are missing), rewind first;
  - `stopReason: "stop"` → tells you the turn is already complete;
  - no messages in the branch at all → refuses ("send a message first");
  - leaf is an `a-rewind` label whose target was a **user message** → the rewind moved that message into the editor (Pi's re-edit semantics) and the branch no longer contains it; `/retry` refuses and tells you to press Enter to re-send.
- **Auto-continue hangs off `agent_end`, and it checks Pi's own classifier before acting.** The run is still open in `agent_end` (the handler is awaited), which is what lets a print-mode child continue too — a timer after `agent_settled` loses the race with process exit. To avoid racing the built-in retry, the layer acts only when Pi will not retry again: `isRetryableAssistantError` (imported from `@earendil-works/pi-ai/utils/retry`) says the error is not retryable, **or** the same error text came back more times than `settings.retry.maxRetries` + 1. If the import ever fails, the layer does nothing rather than guess. The stop decision is `isHardStopError` in `common/retry-policy.ts` — the same list the sub-agent respawn loop uses, so no private copy. Switch it off with `aRewind.autoContinue: false` in `settings.json`; the wait is abortable with Esc. It also runs inside sub-agent children (they load this extension), which is why a blip usually costs a few seconds of silence rather than a respawn.
- **Extension commands execute immediately mid-stream** — `/pause` can be typed while the agent is still streaming; the wait itself starts at the next turn boundary, and `/continue` cancels a pending request that has not reached it yet.

## `/warm` window (defaults)

| Idle | Action |
|---|---|
| no prior request | skip |
| agent running | skip |
| `< 3m` | skip — cache still hot, pure waste |
| `3m … 4m45s` | fire one short keep-alive turn |
| `> 4m45s` | skip — past Pi’s ~5m miss heuristic; risk of full prefix rebuild |

Constants in `a-rewind/warm-window.ts`: `WARM_MIN_IDLE_MS`, `WARM_MAX_IDLE_MS` (the decision is pure so it is unit-tested in `tests/unit/a-rewind-warm-window.test.ts`; `PAUSE_TOGGLE_KEY` stays in `index.ts`). No settings file. Not free: still a real inference request (quota + rate window). Manual only — no auto timer.

**The idle clock is anchored to the last provider request**, not to `agent_settled`: a prompt-cache entry's TTL starts when the provider receives the request, so a long reasoning reply would otherwise leave the clock reading "just went idle" for a cache already near expiry — and the keep-alive would land after it expired (a full-price rebuild). `before_provider_request` stamps the send time; a resumed session falls back to the last assistant timestamp. This mirrors Pi's own warmer, which schedules the refresh at 90% of the model's declared TTL.

**Native alternative (Pi 0.86.0+): `cacheWarming` — not callable from an extension.** The warmer is internal (`CacheWarmer`, built in the TUI) and reaches extensions only through the `cache_warming_decision` event (override the action); there is **no** API to *start* one, so `/warm` keeps its own synthetic trigger turn and only borrows the schedule model. Pi's own warmer: `cacheWarming: "off" | "streaming" | "idle"` (settings.json, default `streaming`; `"idle"` also warms between runs), replays the last request with a 1-token cap, cost-gated at ≥$0.05 avoided miss, next decision shown in `/session`. It is **inert on this host**: a model is eligible only when it declares a cache lifetime via `promptCache`, and neither the `kimi-coding` nor the `xai` built-in catalog sets it. Enabling it (`promptCache: { short: 300 }` per model — Kimi's default tier is 5 min, extended on every hit, `docs/research/kimi-cache-miss-research.md` §5.1 — plus `cacheWarming: "idle"`) would make `/warm` redundant, but auto warming is not wanted here: `/warm` stays manual.

## Session affinity (automatic)

Uses Pi session id (`ctx.sessionManager.getSessionId()`):

| Channel | What | When |
|---|---|---|
| `before_provider_headers` | `x-session-affinity`, `x-session-id` | every request (skip if already set) |
| `before_provider_request` | body `prompt_cache_key` | OpenAI-shaped payloads only (no top-level `system`); skip if already set |

Does **not** change provider/API. Cost 0. Complements `/warm` (warm re-hits cache; affinity improves odds you land on the node that holds it).

Pi has a native equivalent gated by model compat: `compat.sendSessionAffinityHeaders` + `compat.sessionAffinityFormat` (`"openai"` → `session_id` + `x-session-affinity` + `x-client-request-id`; `"openrouter"` → `x-session-id`). Both the `kimi-coding` and `xai` built-in catalogs leave it **unset**, so Pi sends none of these today and this handler is the only source — it also sets *both* `x-session-affinity` and `x-session-id`, which the native path never does. Migrating it into `models.json` would drop the handler but lose the dual-header behaviour; leave as is unless a capture proves one header alone is enough.

xAI Grok on Responses already gets `prompt_cache_key` from Pi — that is their sticky-routing knob. These headers do not replace it; xAI docs want `x-grok-conv-id` only on Chat Completions. Hits still are not guaranteed (per-server cache; see `docs/pi-provider-payloads.md` §1a).

## Important behaviors

- Rewinding uses `ctx.navigateTree()`, which creates a branch without deleting history.
- Every rewind reports what it actually did: the target entry (with a short preview for user messages) and how many message entries were removed. This makes "extra cut" (e.g. the user message landed in the editor — press Enter to re-send) and "not enough cut" (only the last LLM turn was removed, tool turns above remain — use `/a-rewind-user` for the whole run) visible immediately.
- `navigateTree` treats a **user message target** as "re-edit": the leaf moves above the message and its text goes to the editor. So `/a-rewind` right after a single-turn reply, and `/a-rewind-user`, leave your message in the editor rather than in the tree — press Enter to re-send (a new turn starts). `/retry` refuses in this state instead of feeding the LLM a context without your last instruction.
- After `navigateTree`, the session leaf is the `a-rewind` **label entry** (the runtime advances the leaf on every append, including labels), so subsequent entries hang under the label. This is invisible to the LLM (labels are not context messages) but means leaf-based checks must look at the last message in the branch instead.
- Task timing is purely informational; it does not affect session logic. The timer starts on `agent_start` (guarded, so mid-run continuations do not restart it) and finishes on `agent_settled`, which fires once per full run — this covers `/retry` runs and steering/follow-up continuations, which never emit `before_agent_start`. Paused wall time is excluded from the timer.
- The post-run summary notify (`task time: …`) was **removed (2026-08)** — ui-theme turn log covers it: `zz-turn` status block + scrollback `ui-turn` entry report duration and tool count per turn. Per-task totals (whole run incl. pause time) are no longer shown; `/a-rewind-tt` status-bar timer and `/warm` idle anchor (`lastRequestAtMs`) are unchanged.
- `/pause` waits inside the `turn_start` handler, which the agent loop awaits before each LLM request. At that point the previous assistant message and all its tool results are already persisted and no HTTP stream is open, so the freeze is clean: no history edits, no trigger messages. The wait resolves on `/continue`, on abort (Esc), or on session shutdown. Limits: the current LLM response and its tool calls (including a long bash) always finish first — pausing mid-stream or mid-tool is impossible by design.
- While paused, commands that await `waitForIdle()` (`/a-rewind*`, `/retry`) block until `/continue` — resume first. `/warm` refuses while paused/busy instead of waiting.
- `/retry` uses `pi.sendMessage(..., { triggerTurn: true })` with a hidden trigger message (`customType: "a-retry-trigger"`, `display: false`). A `context` hook strips the trigger before it reaches the LLM, so the model sees the same conversation it would have seen without `/retry`. If stripping ever leaves the context ending on an `assistant` message, a minimal empty `user` placeholder is appended to preserve role alternation.
- `/warm` uses the same hidden-trigger pattern (`customType: "a-warm-trigger"`). The quiet cue (`Reply with exactly: ok. Do not use tools.`) is injected **only on that ping turn** (trigger is the last message). Later turns strip the trigger **and** the ping reply from LLM context, so the cue cannot stick onto the next real task. Refuses incomplete leaves (`aborted`/`error`/`toolUse`) — rewind first. The ping reply may still flash in the TUI (not rewound).
- **Never inject massive text through `pi.sendMessage` or `pi.sendUserMessage` in a single call.** Large messages (>~8 KB) can corrupt the session JSONL or overflow context, causing model degradation (text-only responses instead of tool calls). Write large files via `bash` with a heredoc or `write` tool instead.
