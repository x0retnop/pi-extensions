# Roadmap — deferred decisions

Decisions and ideas put off on purpose, so they stop being re-researched from scratch every time
they resurface. This is a **TODO substitute, not a diary**: work *state* lives in commit messages.

Rules: one line per item — what is undecided, and what would settle it. Delete the line when it is
decided (the reason goes into `docs/decisions.md`, the fact into the topic doc or `burned.md`). No
dated progress notes.

| Area | Open question | Settled by |
|---|---|---|
| Rendering | `pi-multi-edit` uses pattern B (`renderShell: "self"` + its own `Box` bg). Pattern A (`"default"`, drop the Box) is simpler but touches the most burned area; both are defined in `tool-rendering.md` §"The two patterns". | Trying pattern A in a live session; keep only if the row looks identical. |
| Rendering (extra) | `pi.registerToolRenderer()` (1.0.1) unused — it draws tool calls whose tool is not registered (MCP tools, resumed sessions). Same "tinker with rendering when I feel like it" bucket as the row above; not needed today (unregistered calls already print `key=value`). | A live session with a call to an unregistered tool. |
| Provider retry | **Fallback model on provider failure.** When a provider keeps failing after every retry layer (`common/retry-policy.ts`), the turn dies instead of moving to another model. Deferred 2026-10-21 (operator: not yet). Shape it would need: on final `auto_retry_end{success:false}` or on `agent_settled` with a non-hard error, `setModel(<backup>)` + continue, with the reason it fired printed once and the backup named in settings; the costs are a cold prompt cache on the new provider and a second key/subscription that must actually work. `session.setModel` is reachable from an extension (`bindCore`), so no runtime patch is required. | A real outage that costs a working turn after all three layers gave up, or a second provider configured that is idle anyway. |
| off-doc | Pages deliberately not adapted (`mcp`, `codemode`, `rpc-commands`, `rpc-extension-ui`, `llama-cpp`, `terminal-setup`, `tmux`, `termux`). | Adapter on demand: adapt the page the first time a real task needs it. |
| Subsystems | Prune what the 1.0.1 upgrade left unused (from `docs/pi-update-check.md`: "plan a separate session for pruning unused subsystems"). | Its own session. |
| TUI keys | **Parked 2026-10-06 (operator: rare, no extra machinery for it).** A stray keystroke from desktop automation kills a running turn: `app.interrupt` is a bare Escape, `/keys` binds **one chord**, and the double/triple press cannot be expressed there (Pi's own double-Esc for `/tree` is an internal 500 ms timer, not a binding). Interim, no code: `app.interrupt` = `ctrl+escape` via `/keys`. | A ~50-line extension only if it bites again *after* that rebind: `ctx.ui.onTerminalInput` (runs before the editor, `consume: true`) swallows a lone `"\x1b"` while streaming and calls `ctx.abort()` on the **third** press within ~700 ms, passing through when idle or the editor has text (autocomplete, dialogs and the idle double-Esc untouched). Cost that would justify it: another dead turn mid-tool (the 2026-10-06 klip0 case, `docs/burned.md`). |

## Tool-row revision — the rows still to do

Every live row has now been through the same pass — `write`, `bash`, `pwsh`/`py`, `read`, `grep`,
`spawn_agent`, `web_search`/`fetch_content` — against the 1.0.1 runtime and the session logs, in the
`[write-mode]`, `[context-guard]`, `[pi-agent-run]`, `[read-mode]`/`[grep-tool]` and
`[web-search-st]` commits of 2026-10-05/06: own execute only where the native path could not do the job, per-row state carried in
`context.state` instead of a module map, renderer inheritance checked against the built-in it inherits
(or replaced where a new tool name had none), failures returned as `isError` results, and the call line
left to pi-tui `Text` instead of hand-rolled width math. Every other row predates that pass, so each one
needs the same treatment — a freshness check first, a rewrite only where the row is actually wrong.
Leftovers found on the way (dead helpers, stale doc claims, duplications) belong in that row's commit,
not in a separate cleanup.

Recipe — each step is owned by the doc named, do not re-derive:

1. Read how 1.0.1 composes the row: `docs/tool-rendering.md` §"1.0.1 internals" (`resolveToolRenderers` →
   `withBuiltInRenderers` → `ToolExecutionComponent`).
2. Render the **real** renderer pair outside the TUI against one shared `context.state`, in every state:
   running / settled / expanded / error, at width 80, 40, 24 — `docs/tool-rendering.md` §"Renderer
   harness". That is how the bash duration loss was proven, not by reading the code alone.
3. Measure before changing: `stream-tool-log` for deltas, session JSONL for argument/result shape, the
   same census habit as the `[write-mode]` (`1071 writes`, `docs/extensions/write-mode.md`) and
   `[context-guard]` (`12 151 bash rows`) commits. No new parameter or result field without a failure
   class in the logs (`docs/decisions.md` §D32).
4. Gates: `npm run typecheck`, `python scripts/run-tests.py`, `python scripts/build-extensions.py`; docs
   in the same commit; deploy is `sync-extensions.ps1` + Pi restart (the user runs both).

| Row | What is suspicious / open | Settled by |
|---|---|---|
| Every row | Description text: role policy must not be repeated in a tool schema (the `bash` description was trimmed to `Execute a bash command. Returns stdout and stderr.` for exactly that) | Reading each description against the live role prompts; rule in `docs/burned.md` (2026-09-23) |
