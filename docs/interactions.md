# Extension / Runtime Interactions

This doc maps how the active extensions interact with each other and with the Pi runtime. Use it when a tool is missing, a prompt looks wrong, or behavior changes after a session switch.

## Event handler order

Pi invokes extension handlers in the order extensions were loaded. Current runtime order (from `~/.pi/agent/extensions/` listing):

```
a-rewind, auto-trust, context-guard, grep-tool, model-manager,
pi-multi-edit, pi-project-memory, pi-session-memory, pi-web-search,
read-mode, role-sw, simple-gate, sub-agents
```

Important sequences:

- **`session_start`**: a-rewind → context-guard → model-manager → pi-project-memory → pi-web-search → role-sw → simple-gate.
- **`before_agent_start`**: a-rewind → context-guard → role-sw → context-guard (dump capture) → model-manager has no handler here.
- **`tool_call`**: simple-gate only.
- **`session_tree`**: context-guard → model-manager → pi-project-memory → pi-web-search.

Because handlers run in load order, later handlers can override earlier ones if they mutate the same state.

## System prompt pipeline

```text
Pi builds base system prompt
  ├── context-guard strips unwanted parts (date, cwd, skills, pi docs, ancestor agents, tool snippets, role override)
  ├── context-guard injects queued skills
  └── role-sw appends active role markdown ("## Role Override (...)")
      (can be stripped if context-guard's roleOverride rule is disabled)
```

**Conflict**: if `context-guard.roleOverride` is disabled, the role injected by `role-sw` is removed. This is by design but can be surprising.

## Tool override map

Extensions that call `pi.registerTool()` with the same name as a built-in tool replace it:

| Tool | Extension | Notes |
|------|-----------|-------|
| `read` | `read-mode` | Mode-aware: overview/section/grep/headtail/raw |
| `edit` | `pi-multi-edit` | Exact replacement with batch + partialApply |
| `grep` | `grep-tool` | ripgrep-based, with broad-query guard |

No two active extensions override the same tool, so there is no conflict today.

## Active tool list mutations

Several extensions call `pi.setActiveTools()`. Because Pi applies the **last** `setActiveTools()` result, load order matters.

| Extension | When | What it does |
|-----------|------|--------------|
| `context-guard` | `session_start`, `session_tree` | Removes managed tools, then re-adds based on toggles (currently `session_memory`) |
| `pi-project-memory` | `session_start`, `session_tree` | Adds `project_facts` and `curate_facts` if `.project-id` exists, removes if not |
| `pi-web-search` | `session_start`, `session_tree` | Adds web tools if session state says ON, otherwise keeps only `web_access` |

**Risk**: if two extensions manage the same tool name, the last one wins. Currently no overlap.

**Known gap**: `context-guard` has a commented-out `webAccess` tool gate. If enabled later, it must coordinate with `pi-web-search` or they will fight over the active tool list.

## settings.json consumers

All of these read and/or write `~/.pi/agent/settings.json`:

| Extension | Key | Action |
|-----------|-----|--------|
| `context-guard` | `contextGuard` | read/write toggles |
| `simple-gate` | `simpleGate` | read mode/roots, write mode |
| `sub-agents` | `subAgents` | read/write policies and extension lists |
| `pi-project-memory` | `projectMemory.debug` | read/write debug flag |

`model-manager` does **not** use `settings.json`; it uses `~/.pi/agent/model-manager.json`.

**Risk**: concurrent writes from different extensions could theoretically corrupt `settings.json`, but each extension reads before writing and only touches its own key, so collisions are unlikely.

## 0x010 backend wiring

Three extensions talk to the same backend (`C:/10x001/AI comp/0x010`):

| Extension | Endpoint prefix | Env URL resolution |
|-----------|-----------------|-------------------|
| `pi-web-search` | `/api/web_research/*`, `/mcp` | `PI_WEB_SEARCH_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000` |
| `pi-project-memory` | `/api/project_memory/*` | `PI_PROJECT_MEMORY_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000` |
| `pi-session-memory` | `/api/session_index/*` | `PI_SESSION_MEMORY_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000` |

They use independent HTTP clients (no shared client module). If one extension gets a new URL env var, the others do not automatically follow.

## Permission flow

```text
tool_call emitted
  ├── simple-gate decides allow / ask / block (read/write/edit/bash)
  └── if allowed, the actual tool executes (built-in or overridden)
```

`auto-trust` runs earlier on `project_trust`, not `tool_call`, so it does not interfere with `simple-gate`.

## Sub-agents isolation

- `sub-agents` spawns child `pi` processes with `PI_SUB_AGENTS_CHILD=1`.
- The extension checks this env var and skips registration inside children.
- Child agents can load a custom extension set. Default custom set: `grep-tool`, `pi-multi-edit`, `read-mode`, `simple-gate`.
- This means overrides like `read-mode` and `pi-multi-edit` also apply inside sub-agents when included.

## Custom session entry types

Extensions store state in the session branch using `pi.appendEntry()`:

| Extension | customType | Purpose |
|-----------|------------|---------|
| `role-sw` | `role-switcher` | active role |
| `model-manager` | `model-manager-state` | lightweight refresh markers |
| `pi-web-search` | `web-access-state` | web tools on/off |
| `pi-project-memory` | `project-memory-curate-state` | curation mode |
| `pi-session-memory` | `session-memory-search` | last search results |
| `context-guard` | `skill-guard` | skill injection records |
| `context-guard` | `skill-loaded` | skill loading records (overview) |

## Known conflicts and gaps

### 1. `context-guard` vs `pi-web-search` tool gate

`context-guard/tool-gates.ts` has a commented-out `webAccess` gate. If enabled, both extensions would call `setActiveTools()` for `web_search`, `fetch_content`, `code_search`, and `web_access`. They must either be merged into one controller or use a shared state key.

**Recommended fix**: leave web access control to `pi-web-search`. Remove or never enable the `context-guard` webAccess gate.

### 2. `pi-project-memory` `.project-id` vs launching Pi inside an extension folder

If Pi is launched from inside an extension folder (to load its local `AGENTS.md`), `pi-project-memory` looks for `.project-id` there, not in the real project. This is the user's intended workflow but can be confusing.

**Workaround**: create `.project-id` in the extension folder only if you want memory bound to that extension; otherwise launch Pi from the real project root.

### 3. `simple-gate` and overridden tools

`simple-gate` intercepts `tool_call` for `read`, `write`, `edit`, and `bash`. It runs **after** the tool has been selected but **before** execution. It sees the final resolved tool name, so it works with overrides (`read-mode`, `pi-multi-edit`).

### 4. `model-manager` provider re-registration

`applyCuratedRegistrations()` calls `pi.unregisterProvider()` then `pi.registerProvider()` on every `session_start` and `session_tree`. If a provider registration fails (e.g., missing API key), the provider remains unregistered for that session. The UI will show it as unavailable.

### 5. `context-guard` dump capture vs privacy

`context-guard/dump.ts` captures the full system prompt, messages, and provider payload on every turn. The `/context-guard` TUI can display this. No data leaves the machine, but the dump is in memory for the session.

## Troubleshooting

### Tool missing

1. Is it built-in? Check `docs/pi-tool-internals.md` §5.
2. Is it managed by `context-guard`? Run `/context-guard status`.
3. Is it a web tool? Check `/web-status` and session state.
4. Is it a project-memory tool? Check `.project-id` in `cwd`.
5. Did `simple-gate` block it? Look for gate prompts.

### System prompt looks wrong

1. Check `/context-guard status` — which prompt rules are off?
2. Check active role with `/role`.
3. Use the dump view in `/context-guard` to inspect the final prompt.

### Gate blocks unexpectedly

1. Check `/gate-mode`.
2. Check `~/.pi/agent/settings.json` → `simpleGate.workspaceRoots` and `simpleGate.protectedRoots`.
3. Verify path normalization: Git Bash `/c/...` is converted to `C:/...`.

### Web tools/backend unavailable

1. Is 0x010 running? Check `pi-web-search` `/web-status`.
2. Are env vars `PI_WEB_SEARCH_URL` / `PI_BACKEND_URL` set?
3. Does the 0x010 backend have the required module enabled (`WEB_RESEARCH_ENABLED`, `PROJECT_MEMORY_ENABLED`, `SESSION_INDEX_ENABLED`)?
