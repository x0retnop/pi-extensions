# Extension / Runtime Interactions

This doc maps how the active extensions interact with each other and with the Pi runtime. Use it when a tool is missing, a prompt looks wrong, or behavior changes after a session switch.

Catalog of what each extension is: `docs/extensions/INDEX.md`.

## Event handler order

Pi invokes extension handlers in the order extensions were loaded. Current runtime order (from `~/.pi/agent/extensions/` listing, 2026-08-26):

```
a-rewind, context-guard, context-trim, grep-tool, keybinds, model-manager,
payload-trace, pi-agent-run, pi-multi-edit, pi-session-memory,
read-mode, role-sw, simple-gate, stream-tool-log, sub-agents, ui-theme,
web-search-st
```

Repo `pi-web-search` is archived (`_archive/pi-web-search.zip`) — do not resurrect it next to `web-search-st` (same tool names, `/web`, `web-access-state`). Live runtime uses `web-search-st`.

(`context-trim` only mutates `context` messages when `/trim` is on.)
(`ui-theme` is chrome-only: setFooter / setStatus rate / banner+boot notify / setWorkingVisible / turn log — no tools or prompt mutation.)
(`model-manager` may collapse `assistant-thinking` markdown for Grok 4.5+ via `registerMarkdownTransformer` — display only, `/grok-think`.)
(`keybinds` is TUI-only: `/keys` writes `keybindings.json` + live `setUserBindings`, built-in ids only — extension shortcuts are not in that file.)
(`payload-trace` is off by default: `/payload-trace start|stop` full payload capture. No tool/prompt mutation.)
(`stream-tool-log` is file JSONL only, `/streamlog`. No tool/prompt mutation.)
(`pi-agent-run` registers `pwsh`/`py`; `session_start` only drains spill files.)

Important sequences (handlers that exist, in load order):

- **`session_start`**: a-rewind → context-guard → context-trim → model-manager → pi-agent-run (spill cleanup) → role-sw → simple-gate → stream-tool-log (file) → sub-agents → ui-theme (footer/banner/working) → web-search-st (tools on/off).
- **`before_agent_start`**: a-rewind → context-guard → role-sw → context-guard (dump capture) → sub-agents (replaces `<!-- sub-agents -->` with `_Sub-agents.md` when `/sub` is on). model-manager has no handler here.
- **`tool_call`**: simple-gate only (and only for `read`/`write`/`edit`/`bash`).
- **`session_tree`**: context-guard → context-trim → role-sw (restores the role saved in the newly selected branch) → sub-agents → web-search-st. model-manager does not re-register providers here.
- **`context`**: context-guard (notices) → context-trim (only if a prior manual `/trim` left a frozen stub map) → a-rewind (retry trigger strip; warm ping cue only while the trigger is last, else strip trigger + ping reply).
- **`before_provider_request`**: context-guard enforces disabled prompt rules on the outgoing payload (strip-only, after ALL extensions), then captures the final payload for dumps/inspect. payload-trace may also snapshot if capture is on.

Because handlers run in load order, later handlers can override earlier ones if they mutate the same state.

## System prompt pipeline

```text
Pi builds base system prompt (SYSTEM.md canary + cwd; P-3/P-4 drop AGENTS + skills XML)
  ├── context-guard strips unwanted parts (date, cwd, leftover wrappers, pi docs, tool snippets)
  ├── context-guard injects queued skills; on empty session may send cwd/AGENTS.md as first hidden message
  ├── role-sw replaces the canary with the active role, keeps cwd/date
  └── sub-agents replaces `<!-- sub-agents -->` with `_Sub-agents.md` when the tool is on; strips the marker when off
```

**Note**: `context-guard` is loaded before `role-sw`, so `before_agent_start` alone cannot strip the role. The `roleOverride` rule is therefore enforced on the provider payload (`before_provider_request`), which runs after role-sw — disabling it really removes the role from the outgoing request.

## Tool override map

Extensions that call `pi.registerTool()` with the same name as a built-in tool replace it:

| Tool | Extension | Notes |
|------|-----------|-------|
| `read` | `read-mode` | Mode-aware: overview/section/raw |
| `edit` | `pi-multi-edit` | Exact single replacement; separate `multi_edit` for batch and `insert` for line insertion |
| `grep` | `grep-tool` | ripgrep-based, with broad-query guard |
| `write` | `write-mode` | Pi's schema and file semantics (path resolution, per-path queue, abort); own execute adds BOM preservation + a sized result line, row is one line |
| `bash` | `context-guard` | Own `renderCall` (**not** a gated tool — that is `simple-gate`); native `execute` via `createBashToolDefinition`, native `renderResult` inherited by name; header owns the duration and keeps it after the row settles. Toggleable: `contextGuard.features.bash` removes the tool from the active set |

Added (not overrides): `pwsh` / `py` (`pi-agent-run`). Web tools (`web_search`, `fetch_content`) come from `web-search-st` (the only loaded web extension).

No two **loaded** extensions override the same tool, so there is no conflict today — unless both web extensions are loaded (see Known conflicts).

**Agent-loop parallel:** none of these overrides set `executionMode: "sequential"`. Multiple independent tool calls in one assistant message run concurrently (Pi default). `pi-multi-edit` still serializes **same-path** writes via `lock.ts`; different files stay parallel. See `docs/pi-tool-internals.md` §8.

## Active tool list mutations

Several extensions call `pi.setActiveTools()`. Because Pi applies the **last** `setActiveTools()` result, load order matters.

| Extension | When | What it does |
|-----------|------|--------------|
| `context-guard` | `session_start`, `session_tree` | Removes managed tools, then re-adds based on toggles (currently `bash`) |
| `web-search-st` | `session_start`, `session_tree` | Adds web tools if session state says ON, otherwise removes them entirely |

**Risk**: if two extensions manage the same tool name, the last one wins. No overlap as loaded — only `web-search-st` provides web tools.

**Known gap**: `context-guard` has a commented-out `webAccess` tool gate. If enabled later, it must coordinate with whichever web extension is loaded or they will fight over the active tool list. Leave web access control to the web extension.

## settings.json consumers

All of these read and/or write `~/.pi/agent/settings.json`:

| Extension | Key | Action |
|-----------|-----|--------|
| `context-guard` | `contextGuard` | read/write toggles |
| `simple-gate` | `simpleGate` | read mode/roots, write mode |
| `sub-agents` | `subAgents` | read/write policies and extension lists |
| `web-search-st` | `webSearchSt` | default web on/off (session `web-access-state` wins) |

`model-manager` stores its own state in `~/.pi/agent/model-manager.json`. The role-map settings UI also writes `roleSwitcher.modelRoleMap` in `settings.json` (shared with `role-sw`).

**Risk**: concurrent writes from different extensions could theoretically corrupt `settings.json`, but each extension reads before writing and only touches its own key, so collisions are unlikely.

## Local backend wiring

**No live extension calls the local backend** (since 2026-09-20). The wiring table and the archived clients (`pi-web-search`, `pi-project-memory`) live in `docs/local-backend.md` §"Endpoints used by Pi extensions". Each extension that ever spoke to it carried its own HTTP client — no shared module — so a new URL env var on one never propagated to another.

## Permission flow

```text
tool_call emitted
  ├── simple-gate decides allow / ask / block (read/write/edit/bash only)
  └── if allowed, the actual tool executes (built-in or overridden)
```

`pwsh` / `py` are **not** gated.

## Sub-agents isolation

- `sub-agents` spawns child `pi` processes with `PI_SUB_AGENTS_CHILD=1`.
- The extension checks this env var and skips registration inside children.
- Role agents (`includeExtensions: true`) load the parent's full extension set; `--tools` is the real filter. `pwsh`/`py` need both `pi-agent-run` (loaded with the full set) and those names in `--tools`.
- Legacy settings keys `defaultExtensionsPolicy` / `defaultCustomExtensions` / `agentExtensions` are ignored.

## Custom session entry types

Extensions store state in the session branch using `pi.appendEntry()`:

| Extension | customType | Purpose |
|-----------|------------|---------|
| `context-trim` | `context-trim-state` | /trim on-off, minChars, last stats |
| `role-sw` | `role-switcher` | active role |
| `model-manager` | `model-manager-state` | lightweight refresh markers |
| `web-search-st` | `web-access-state` | web tools on/off (archived `pi-web-search` used the same type) |
| `pi-session-memory` | — | local browser/export only; no session entries |
| `context-guard` | `skill-guard` | skill injection records |
| `context-guard` | `context:skill_loaded` | skill loading records (overview) |
| `ui-theme` | `ui-turn` | turn-log rows (`/timestamps`) |

## Known conflicts and gaps

### 1. `pi-web-search` XOR `web-search-st` (resolved: `pi-web-search` archived)

`pi-web-search` is archived (`_archive/pi-web-search.zip`); it shared tools (`web_search`, `fetch_content`), `/web`, and `web-access-state`, and both call `setActiveTools()`. Live runtime: `web-search-st` only. Do not stack.

### 2. `context-guard` vs web tool gate

`context-guard/tool-gates.ts` has a commented-out `webAccess` gate. If enabled, both it and the web extension would call `setActiveTools()` for the web tools. Leave web access control to the web extension.

### 3. `simple-gate` and overridden tools

`simple-gate` intercepts `tool_call` for `read`, `write`, `edit`, and `bash`. It runs **after** the tool has been selected but **before** execution. It sees the final resolved tool name, so it works with overrides (`read-mode`, `pi-multi-edit`). It does not see `pwsh`/`py`.

### 4. `infer-local` refresh is a `/mm` row, not a slash command

`infer-local` registers the local provider from its cache and does not probe on load. `/mm` asks it over `pi.events` (`infer-local:providers` sync, `infer-local:refresh` with `ack` then `done`). A direct import would be a second jiti copy and would miss the registration. No `/infer-local` command.

### 5. `model-manager` provider re-registration

`applyCuratedRegistrations()` runs on `session_start` (and TUI edits). First apply only `registerProvider` (Pi already overrides built-ins). `unregister`+`register` only when replacing a previous apply in this process. Same curation fingerprint is a no-op. Missing API key → skip that provider; it stays unregistered until the next apply that has a key.

### 6. `context-guard` dump capture vs privacy

`context-guard/dump.ts` captures the full system prompt, messages, and provider payload on every turn. The `/context-guard` TUI can display this. No data leaves the machine, but the dump is in memory for the session.

## Troubleshooting

### Tool missing

1. Is it built-in? Check `docs/pi-tool-internals.md` §5.
2. Is it managed by `context-guard`? Run `/context-guard status`.
3. Is it a web tool? Check `/web` / `/web-status` and session `web-access-state`. Confirm which web extension is loaded.
4. Did `simple-gate` block it? Look for gate prompts (`read`/`write`/`edit`/`bash` only).

### System prompt looks wrong

1. Check `/context-guard status` — which prompt rules are off?
2. Check active role with `/role`.
3. Use the dump view in `/context-guard` to inspect the final prompt. Note: the dump captures the final provider payload only **after** at least one LLM turn; before the first turn it shows the base prompt before extensions such as `role-sw` have mutated it.

### Gate blocks unexpectedly

1. Check `/gate-mode`.
2. Check `~/.pi/agent/settings.json` → `simpleGate.workspaceRoots` and `simpleGate.protectedRoots`.
3. Verify path normalization: Git Bash `/c/...` is converted to `C:/...`.

### Web tools/backend unavailable

1. Web tools come from `web-search-st`, which does not need the local backend (`pi-web-search` is archived).
2. Check `/web` / `/web-status`; confirm the session `web-access-state` says ON.
3. `pi-session-memory` no longer needs the local backend (local browser + export).
