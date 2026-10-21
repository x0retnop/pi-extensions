# context-guard

Extension-level control over the system prompt and active tool set.

## What it does

- Removes or keeps pieces of the system prompt before each LLM turn (date, cwd, AGENTS.md wrappers, skills, Pi docs, tool snippets, role override).
- Optionally injects `cwd/AGENTS.md` once as the first hidden custom message on an empty session (`agentsInject`, default ON). Pair with runtime P-3 so the file is not also in the system prompt.
- Toggles which tools are visible to the LLM (currently `bash`).
- Controls automatic skill injection and provides `/use-skill` for manual skill injection.
- Saves all toggles in `~/.pi/agent/settings.json` under the `contextGuard` key.
- Optional one-shot context pressure notices at 60% / 70% (user-shaped via `context` event).

## Context notices

- Master **OFF** by default. Per-threshold toggles default **ON**.
- On each LLM call (`context` event), if `getContextUsage().percent` crosses **60** or **70** and that threshold has not fired yet this session, inject the body of `notice-60.md` / `notice-70.md` (extension root) as a `custom` → LLM `user` message (`display: false`).
- One-shot per threshold per session; jump 50→75 fires both (60 then 70) when both are enabled.
- Fired flags are in-memory only (reset on `session_start`; TUI can clear them). Prompt files are cached; TUI can reload.
- HTML comments in the `.md` files are stripped before inject.

## Important behaviors

- **Boot ribbon (one-shot).** On every `session_start` (`startup` / `reload` / `new` / `resume` / `fork`) a compact **enabled-only** list is rendered as a **transient chat line** via `notify` (same path as the ui-theme banner). OFF items are omitted. Not a widget — it sits at the end of the transcript and scrolls away; it does not pin above the editor. Never written to the session file, never sent to the LLM. Skin (frame, rails, item extras) comes from `uiTheme.boot` — see `docs/extensions/ui-theme-presets.md`. Runtime never leaves it unframed (`none` inherits footer `frameStyle`). When the banner is also on, both land in one notify so they do not clobber each other.
- **Date rule.** Since Pi 0.80.7 the default prompt no longer contains `Current date:`. With the `date` rule enabled (default), context-guard appends `Current date: YYYY-MM-DD` (local, day granularity — the prompt cache busts at most once per day). Disabled → strips any date line. Time-of-day is deliberately NOT injected: the system prompt is the prompt-cache prefix and a per-turn clock would bust the cache on every request; use `date` in bash for the clock.
- **Payload-level enforcement.** A `before_provider_request` handler re-applies all disabled rules (strip-only, idempotent) to the actual outgoing payload. This runs after EVERY extension's `before_agent_start`, so content appended downstream — e.g. `role-sw`'s `## Role Override` — is really removed when its rule is OFF. When the prompt is already clean the payload passes through untouched (no cache impact; output is deterministic).
- **Reality anchoring.** Inspect's "Final system prompt" is the last provider `system` string (role + cwd + date). The `SYSTEM.md ~N tok` line is the **canary input**, not the outgoing prompt. API-reported tokens include conversation + tool schemas (so first-message AGENTS is in that number, not in Final). Pre-first-turn figures are the canary+cwd base — role is not in them yet. Role size is read from `role-sw/roles/`.
- **First-message AGENTS.md.** On `session_start`, if `agentsInject` is ON, the session has no user/assistant messages and no prior `project-agents` entry, and `cwd/AGENTS.md` exists and is non-empty: `sendMessage` (hidden) with a one-line banner (`Follow this project guide… Disk only if editing: <path>`), a blank line, then the raw file. Missing or empty file → no message (cwd stamp in the system prompt is separate). Skips sub-agent children (`PI_SUB_AGENTS_CHILD=1`). Resume/reload/fork keep the existing entry. Toggle in the Prompt TUI or `/context-guard agentsInject`. Verified 2026-08-18 (`01a0167f…`): entry `#4`, `customType=project-agents`, `display=false`, before the first user message.
- **Ancestor AGENTS.md files.** The `ancestorAgents` rule keeps only the `AGENTS.md` located exactly in `cwd`. It does **not** solve the "two AGENTS.md" problem when Pi is launched inside an extension subfolder — it would strip the root file too. With P-3 the stock wrapper is empty, so this rule is a no-op.
- **Tool gates** work by calling `pi.setActiveTools()` on `session_start` and `session_tree`. The `bash` gate removes the built-in `bash` tool from the active tool set entirely, so it is not exposed to the LLM. They can conflict with other extensions that also mutate the active tool list.
- **Bash override** (`bash-override.ts` + `bash-render.ts`): re-registers built-in `bash` with tighter prompt text — the description is deliberately minimal (`Execute a bash command. Returns stdout and stderr.`), because cwd semantics, the Git Bash environment and "which tool when" are role policy and repeating it only pays prefix tokens on every request — keeps native `execute` via `createBashToolDefinition`, and custom `renderCall` only — the native `renderResult` is inherited by name. Call layout matches `pi-agent-run` pwsh/py: header `$ (timeout 5m) 12m 03s` + multi-line body (durations via `common/duration.ts`, so the seconds the agent passed are shown as minutes), syntax via Pi `highlightCode(…, "bash")`, cap `PREVIEW_LINES` (8) with `… +N lines` — **Ctrl+O lifts the cap** and shows the command whole, the way the inherited native build of this row always did. No hard char-truncate — long one-liners wrap via pi-tui `Text`.
  - **The header owns the duration, and keeps it after the row settles.** Pi's native bash row prints `Took 2m 12s` from `renderResult`, but that line is fed by the *built-in* `renderCall` (it seeds `context.state.startedAt`) — which this override replaces, so a stock row would show the duration and this one showed none at all: 14.8% of 12 151 bash rows over 3 weeks ran ≥ 5 s, 2.9% ≥ 30 s (verified 2026-10-05 by rendering both built-in and override pairs against one shared state object). The timer now lives in `context.state.bashTimer` — a **namespaced** key on purpose: the inherited native result renderer reads `startedAt`/`endedAt`/`interval` from the same object and would print a second, duplicate duration. Same 5 s threshold while running and after settling, so short commands look exactly as before.
- **Skills** are discovered once per session from `~/.pi/agent/skills/`, `~/.agents/skills/`, `<cwd>/.pi/skills/`, and `<cwd>/.agents/skills/`.

## State

- Persistent toggles: `~/.pi/agent/settings.json` → `contextGuard.features`, `contextGuard.promptRules`, `contextGuard.autoSkills`, `contextGuard.agentsInject`, `contextGuard.contextNotices`.
- Session skill injection queue and notice fired flags are in-memory only.

## Dependencies

- Can nullify effects from: `role-sw`, automatic skills, built-in Pi docs, ancestor AGENTS.md files.
- Can hide/show tools provided by other extensions (the `bash` gate covers the built-in tool; the `sessionMemory` gate was removed with the pi-session-memory backend on 2026-09-20).
