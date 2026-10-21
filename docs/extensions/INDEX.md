# Extensions catalog

One root folder = one extension. Behavior: `docs/extensions/<name>.md`.
Deploy and lifecycle are the user's job. This list is the **collection**; live `~/.pi/agent/extensions/` may be a subset.

`common/` is shared TS helpers (chrome / status / paint / history-outline), not an extension. Do not treat it as loadable.

## Active (in this repo)

| Name | What it is |
|---|---|
| `a-rewind` | Rewind / retry / pause, task timer, prompt-cache keep-alive (`/warm`) |
| `context-guard` | Prompt cleanup, tool gating, skill control, `cwd/AGENTS.md` inject |
| `context-trim` | Manual superseded full-read trim (`/trim`). No auto |
| `grep-tool` | Project-wide `grep` override (ripgrep) |
| `infer-local` | Stand-in for the `models.json` infer provider: last gateway snapshot, no startup probe; refresh from `/mm` |
| `keybinds` | TUI for `keybindings.json` (`/keys`). Not chrome — do not fold into `ui-theme` |
| `model-manager` | Dynamic provider/model registration, `/mm` |
| `payload-trace` | Manual full request/response capture (`/payload-trace start\|stop`). Off by default |
| `pi-agent-run` | Native `pwsh` / `py` executors (bypass Git Bash quoting) |
| `pi-multi-edit` | `edit` override + `multi_edit` + `insert` |
| `pi-session-memory` | Local session browser (`/sw`), Markdown export, and on-demand model-written session annotations. No backend, no agent tool |
| `read-mode` | Mode-aware `read` (overview / section / raw) |
| `role-sw` | Role injection and persistence; versioned role files auto-follow the newest `-v<N>` |
| `simple-gate` | Path/command permission gate for `read` / `write` / `edit` / `bash` |
| `stream-tool-log` | Live toolcall JSONL (`/streamlog`). Operator-toggle only |
| `sub-agents` | Child `pi` agents (`/handoff`, `/sub-agents`) |
| `ui-theme` | TUI chrome hub: footer, tok/s, banner, Working, turn log (`/ui-theme`, `/timestamps`) |
| `web-search-st` | Standalone keyless web search/fetch (no backend service) |
| `write-mode` | `write` override: Pi's schema and file semantics, own execute (BOM kept, sized result), one-line row |

Wiring, load order, and who mutates `setActiveTools`: `docs/interactions.md`.

## Commands

Single owner for the slash-command surface — per-extension docs do not repeat it, and a command's schema and detailed behavior live in its code. Adding, renaming or retiring a command means editing this table.

| Command | Extension | What it does |
|---|---|---|
| `/a-rewind` | a-rewind | Rewind to before the latest assistant message |
| `/a-rewind-step` | a-rewind | Undo the latest session entry |
| `/a-rewind-user` | a-rewind | Rewind to the latest user message (undoes everything after it) |
| `/a-rewind-tt` | a-rewind | Toggle the task timer in the status bar |
| `/retry` | a-rewind | Start the next agent turn from the current leaf (guards: doc §Non-obvious) |
| `/pause` | a-rewind | Freeze the agent loop at the next turn boundary |
| `/continue` | a-rewind | Resume a loop frozen by `/pause` |
| `/warm` | a-rewind | Prompt-cache keep-alive if idle is inside the warm window; `status` inspects |
| `/context-guard` | context-guard | Guard TUI / status; `<id>` toggles one guard, `reset` restores defaults |
| `/context` | context-guard | Context overview overlay (fill, real/API tokens, loaded skills) |
| `/use-skill` | context-guard | Inject a skill into the next turn (interactive picker without args) |
| `/trim` | context-trim | One-shot superseded full-read trim: `preview`, `clear`, `status`, `min N` (default 2000) |
| `/keys` | keybinds | Keybindings editor TUI |
| `/keybindings` | keybinds | Alias for `/keys` |
| `/mm` | model-manager | Model-manager TUI |
| `/model-manager` | model-manager | Alias for `/mm` |
| `/fav` | model-manager | Cycle favorite models: `/fav next|prev` |
| `/grok-think` | model-manager | Grok 4.5+ thinking-summary display: `hide|show|status` (`off`=hide) |
| `/usage` | model-manager | Provider usage-quota view |
| `/agent-run` | pi-agent-run | `pwsh`/`py` rendering-config TUI |
| `/payload-trace` | payload-trace | Full request/response capture: `start|stop|status` |
| `/sw` | pi-session-memory | Local session picker — Enter opens |
| `/sm` | pi-session-memory | Hub: open a past session, export it to Markdown, or annotate the current one |
| `/note` | pi-session-memory | Annotate the current session — the model writes TITLE + SUMMARY into the session head (F7) |
| `/role` | role-sw | Role picker / switch |
| `/role-config` | role-sw | Default role selection mode |
| `/gate-mode` | simple-gate | Cycle or set the permission gate mode: `strict|relaxed|yolo|off` |
| `/streamlog` | stream-tool-log | Toggle the toolcall JSONL (`on|off`) |
| `/handoff` | sub-agents | Handoff file from the current session |
| `/sub-agents` | sub-agents | Sub-agents TUI: run one agent, review its diff, recent runs, settings |
| `/sub` | sub-agents | Toggle the `spawn_agent` tool for the current session branch |
| `/ui-theme` | ui-theme | Chrome menu: presets, Pi theme, toggles (incl. turn log) |
| `/footer` | ui-theme | Footer shortcuts (`on|off|frame`) |
| `/banner` | ui-theme | Render the banner as a chat line now |
| `/timestamps` | ui-theme | Turn-log scrollback entries and the live `zz-turn` block |
| `/web` | web-search-st | Settings TUI, or `/web on|off` |
| `/web-status` | web-search-st | Same TUI as `/web` |

## Archived

Retired extensions and their docs live in `_archive/` (gitignored, not scanned, not linked from
here). One-line catalog + the retirement procedure: `_archive/INDEX.md`.
