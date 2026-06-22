# Agent Docs v2 — Outline / Foundation

> This is a living draft. It captures the audit findings and proposed skeleton for the new agent documentation system.
> Goal: keep `AGENTS.md` lean and auto-context friendly, move deep/non-obvious details into focused docs, and finally untangle how extensions interact with each other and the Pi runtime.

---

## 1. What we found (audit snapshot)

### Two worlds rule
- **Dev workspace**: `C:/10x001/pi extensions/`
- **Runtime**: `~/.pi/agent/extensions/`
- Changes are copied manually (or via `sync-extensions.ps1`) and only take effect after **restarting Pi**.

### Root `README.md` is stale
- References `pi install`, GitHub URLs, and extensions that do not exist in this workspace (AskU, BTW, Context, Context Manager, Handoff, Ollama Cloud Web, Permission Gate, Protected Paths, Request Inspector, Skill Guard, Sessions, Temperature, Todo, Win Bash Sanitizer).
- Needs to be rewritten to describe the actual local collection and the dev→runtime workflow.

### `docs/` has both gold and legacy
- Strong: `pi-workflow.md`, `pi-version-sync.md`, `pi-local-map.md`, `agent-nav.md`, `pi-tool-internals.md`, `tool-rendering.md`.
- Legacy/noise: `permission-gate.md` (extension disabled/deprecated), `pi-skill-craft.md` may reference removed skill-craft flow, `rpc.md` is huge and mostly reference material.
- Several docs repeat the same workflow rules instead of linking to one source.

### Active runtime extensions (13)
```
a-rewind, auto-trust, context-guard, grep-tool, model-manager,
pi-multi-edit, pi-project-memory, pi-session-memory, pi-web-search,
read-mode, role-sw, simple-gate, sub-agents
```

### Hidden cross-extension complexity
- `read-mode`, `pi-multi-edit`, `grep-tool` **override built-in tools**.
- `context-guard` can **strip pieces of the system prompt** (date, cwd, skills, role override, ancestor agents, pi docs, tool snippets) and **toggle active tools**.
- `simple-gate` intercepts `read/write/edit/bash` and applies path/mode policy.
- `role-sw` injects role markdown; `context-guard` can remove that injection.
- `model-manager` registers providers dynamically.
- `sub-agents` spawns child `pi` processes and suppresses its own registration inside children (`PI_SUB_AGENTS_CHILD=1`).
- `pi-web-search`, `pi-project-memory`, `pi-session-memory` all talk to the same **0x010 backend** (`C:/10x001/AI comp/0x010`) but use different endpoints and env-var fallback chains.
- `pi-project-memory` is silently disabled when no `.project-id` exists in `cwd`.

---

## 2. Design principles for the new system

1. **`AGENTS.md` is a compass, not an encyclopedia.**
   - Hard rules that must survive in the model’s working memory.
   - Tables pointing to the right doc/extension/source.
   - No repetition of long procedures.

2. **Docs capture non-obvious things only.**
   - What is hard to see in the code or runtime types.
   - Cross-extension interactions and ordering constraints.
   - Env-var resolution, backend wiring, and state persistence locations.

3. **Per-extension agent docs live in `docs/extensions/<name>.md`.**
   - One page per extension.
   - Purpose, public commands/tools, critical implementation notes, dependencies on other extensions/runtime files.
   - Link to the source `index.ts` for the rest.

4. **One source of truth per topic.**
   - Dev vs runtime → `docs/pi-workflow.md`
   - Pi version compatibility → `docs/pi-version-sync.md`
   - Tool/command shapes → `docs/pi-quickref.md`
   - Type locations → `docs/pi-local-map.md`

5. **Keep stale/outdated docs out of the active path.**
   - Move or archive deprecated docs (e.g., `permission-gate.md`) so agents do not follow dead instructions.
   - Mark known-stale root `README.md` with a warning until it is rewritten.

6. **Agents do NOT manage extensions.**
   - Enabling, disabling, copying to runtime, archiving, adding/removing from `settings.json` — all user-only.
   - Agents edit code and docs in the dev workspace only.

---

## 3. Proposed file layout

```
AGENTS.md                         # short, critical, auto-loaded
README.md                         # human + agent overview of the repo (rewrite)
docs/
  AGENTS-v2-outline.md            # this draft
  agent-nav.md                    # "where do I look?" quick index
  pi-workflow.md                  # dev vs runtime, sync, deps (one source)
  pi-version-sync.md              # Pi CLI upgrade workflow
  pi-local-map.md                 # where Pi types live
  pi-quickref.md                  # ExtensionAPI events/tools/commands
  pi-tool-internals.md            # tool visibility/rendering/substitution rules
  tool-rendering.md               # renderCall/renderResult pitfalls
  patterns.md                     # copy-paste snippets
  creating-extensions.md          # new extension checklist
  interactions.md                 # cross-extension/runtime wiring map
  git-policy.md                   # how to commit in the shared repo
  extensions/
    a-rewind.md
    auto-trust.md
    context-guard.md              # prompt rules + tool gates + settings key
    grep-tool.md
    model-manager.md              # dynamic provider registration
    pi-multi-edit.md              # edit tool override
    pi-project-memory.md          # .project-id + 0x010 backend
    pi-session-memory.md          # 0x010 session index backend
    pi-web-search.md              # MCP + 0x010 web_research backend
    read-mode.md                  # read tool override
    role-sw.md                    # role injection + persistence
    simple-gate.md                # permission gate policy
    sub-agents.md                 # child pi processes + agent defs
  archive/                        # deprecated docs
    permission-gate.md
```

---

## 4. Draft skeleton for root `AGENTS.md`

```markdown
# AGENTS.md

You are working in the **dev workspace** for Pi Coding Agent extensions.

## Critical rules

- Edit in `C:/10x001/pi extensions/`. Runtime is `~/.pi/agent/extensions/`.
- After code changes, the user copies the extension and **restarts Pi**. Do not test fresh code via bash.
- Do not edit `~/.pi/agent/extensions/` or `~/.pi/agent/settings.json` unless explicitly asked.
- Type-check code changes: `npm run typecheck` from the repo root.
- `@earendil-works/*` and `typebox` are `peerDependencies`. Normal npm deps go in `~/.pi/agent/`.
- **Do not enable, disable, copy, archive, or delete extensions.** That is the user's job.

## When unsure, follow this order

1. Check the table below or `docs/agent-nav.md`.
2. Read the relevant `docs/extensions/<name>.md`.
3. Read the extension source `index.ts`.
4. Only then search the web.

## Where to look

| Need | Look at |
|------|---------|
| Dev vs runtime / sync / deps | `docs/pi-workflow.md` |
| Pi CLI upgrade compatibility | `docs/pi-version-sync.md` (run `python scripts/check-pi-sync.py` first) |
| API types, events, tool/command shapes | `docs/pi-quickref.md` / `docs/pi-local-map.md` |
| Why a tool is missing or behaving oddly | `docs/pi-tool-internals.md`, then `docs/extensions/context-guard.md`, `docs/extensions/simple-gate.md` |
| Per-extension behavior | `docs/extensions/<name>.md` |
| Cross-extension wiring | `docs/interactions.md` |
| Git rules for this shared repo | `docs/git-policy.md` |
| Session log forensics | `scripts/pi_session_inspect.py` |

## Quick context

- `AGENTS.md` / `CLAUDE.md` files in `cwd` and all ancestors are auto-injected. `context-guard` can strip ancestor files.
- `SYSTEM.md` is empty; persona comes from `role-sw` (`~/.pi/agent/roles/`).
- Several extensions override built-in tools: `read-mode` (read), `pi-multi-edit` (edit), `grep-tool` (grep).
- `context-guard` can strip system-prompt parts and toggle tools. `simple-gate` can block/ask read/write/edit/bash.
- Three extensions share the 0x010 backend: `pi-web-search`, `pi-project-memory`, `pi-session-memory`.
- `pi-project-memory` requires `.project-id` in `cwd`.

## Style

- One extension = one folder. Minimal, no frameworks.
- Keep changes reviewable; do not mass-format or rename without request.
- Use commit prefixes from `docs/git-policy.md`.
```

---

## 5. AGENTS.md layering policy (root vs extension-local)

### Root `AGENTS.md` owns
- Dev vs runtime boundaries.
- Type-check, dependency, and style rules.
- "Where to look" navigation.
- Global safety boundaries (do not edit runtime, do not manage extensions).
- Commit/git conventions.

### Extension-local `AGENTS.md` owns
- Extension-specific backend wiring (e.g., 0x010 endpoints).
- Extension-specific conventions and tool usage guidelines.
- Extension-specific doc map.
- **Nothing else.** No duplicated role/style/safety language.

### Current problem
- `pi-project-memory/AGENTS.md`, `pi-session-memory/AGENTS.md`, and `sub-agents/AGENTS.md` currently repeat "Role mode" and generic agent rules.
- When Pi is launched from inside an extension folder, both the root and the local `AGENTS.md` are injected. Repeated rules create ambiguity and can conflict.

### Solution
- Strip local `AGENTS.md` files down to a standard extension-only template.
- Add a standard header: "This file is loaded together with the root `AGENTS.md`. It contains only extension-specific guidance."
- If a local file needs to override a root rule, the override must be explicit and justified.
- Do **not** rely on `context-guard`’s `ancestorAgents` rule to solve this — that would strip the root rules too when launching from a subfolder.

### Standard local `AGENTS.md` template
```markdown
# <extension-name> — Agent Guide

> Loaded together with the root `AGENTS.md`. This file contains only guidance specific to `<extension-name>`.

## What this is
One sentence + one sentence.

## Backend / dependencies (if any)
- 0x010 module, env-var resolution, required files.

## Agent workflow
1. When to use the tools/commands.
2. Non-obvious behavior to remember.

## Where to find work
- `README.md` for user-facing docs.
- `<specific-source-file>.ts` for implementation details.
- External spec/path if needed.

## Documentation map
| File | Purpose |
```

---

## 6. Git policy for the shared repo

This repo contains many independent Pi packages under one git history. The policy must keep history readable without forcing per-extension repos.

### Commit message prefixes
Use a prefix so history can be scanned per extension/topic:

```
[root]       changes to root files: AGENTS.md, README.md, package.json, tsconfig.json
[docs]       shared docs under docs/ (not extension-specific)
[scripts]    scripts/
[<ext-name>] changes inside <ext-name>/, e.g. [context-guard], [pi-multi-edit]
```

### Rules
- One logical change per commit. Avoid mixing unrelated extensions in one commit.
- If a change touches both an extension and shared docs, prefer two commits: `[<ext-name>] ...` then `[docs] ...`.
- Do not mass-rename or mass-format without explicit user request.
- Tags are not required because deployment is manual copy; if used, prefer prefixed tags: `context-guard-v0.2.1`.
- Branches are optional for small edits; use a branch only for large cross-cutting refactors.

### Extension lifecycle is user-managed
- Agents do **not** decide which extensions are active, archived, promoted from `Inactive/`, or copied to runtime.
- If an extension folder exists in dev, document it. Do not delete, move, or create extension folders unless the user asks.

---

## 7. Extension map (condensed)

| Extension | What it does | Key interactions | State location |
|-----------|--------------|------------------|----------------|
| `a-rewind` | Guards fake tool-call announcements; manual rewind | Session entries | - |
| `auto-trust` | Auto-approves safe commands (?) | `tool_call` events | `settings.json`? |
| `context-guard` | Prompt-rule cleanup, tool gating, skill control, TUI | Can nullify `role-sw`, skills, pi docs, ancestor agents; toggles `session_memory` | `~/.pi/agent/settings.json` → `contextGuard` |
| `grep-tool` | Project-wide grep override | Built-in tool substitution | - |
| `model-manager` | Dynamic provider/model registration, `/mm` TUI | Registers providers via `pi.registerProvider` | Config file (TBD: document in extension doc) |
| `pi-multi-edit` | Exact-replacement edit tool with batch modes | Overrides built-in `edit` | - |
| `pi-project-memory` | Vector project facts + todos | 0x010 `/api/project_memory/*`; requires `.project-id` | 0x010 backend |
| `pi-session-memory` | Semantic search over past sessions | 0x010 `/api/session_index/*` | 0x010 backend + custom session entries |
| `pi-web-search` | Web search/fetch/code search via MCP | 0x010 `/api/web_research/*` + `/mcp`; toggles active tools | Custom session entries |
| `read-mode` | Mode-aware read tool (overview/section/grep/headtail/raw) | Overrides built-in `read` | - |
| `role-sw` | Injects role markdown into system prompt | Can be stripped by `context-guard` | `~/.pi/agent/roles/*.md` + custom entries |
| `simple-gate` | Path/command permission gate | Intercepts `read/write/edit/bash`; reads `settings.json` | `~/.pi/agent/settings.json` → `simpleGate` |
| `sub-agents` | Spawns child `pi` agents (`/handoff`, `/sub-agents`) | Suppresses self inside child (`PI_SUB_AGENTS_CHILD=1`) | `~/.pi/agent/settings.json` → `subAgents`; history dir |

---

## 8. Cross-extension/runtime wiring map

```text
Pi runtime
├── AGENTS.md / CLAUDE.md  (cwd + ancestors) ──► context-guard (can strip ancestors)
├── SYSTEM.md (empty) ◄── role-sw reads ~/.pi/agent/roles/*.md
├── before_agent_start
│   ├── context-guard: strip/clean system prompt
│   └── role-sw: inject active role
├── tool_call
│   ├── simple-gate: path/command decisions
│   └── auto-trust / a-rewind: safety helpers
├── session_start / session_tree
│   ├── context-guard: sync active tools
│   ├── model-manager: register providers, restore model
│   ├── pi-web-search: sync web tools from session state
│   ├── pi-project-memory: show/hide project tools based on .project-id
│   └── role-sw: restore active role
└── Active tools
    ├── read-mode overrides built-in read
    ├── pi-multi-edit overrides built-in edit
    ├── grep-tool overrides built-in grep
    ├── session_memory (context-guard toggles visibility)
    └── web_search / fetch_content / code_search (pi-web-search toggles visibility)

0x010 backend (C:/10x001/AI comp/0x010)
├── pi-web-search  → /api/web_research/*  + /mcp
├── pi-project-memory → /api/project_memory/*
└── pi-session-memory → /api/session_index/*

Env resolution for 0x010 URL:
- pi-web-search:     PI_WEB_SEARCH_URL → PI_BACKEND_URL → http://127.0.0.1:8000
- pi-project-memory: PI_PROJECT_MEMORY_URL → PI_BACKEND_URL → http://127.0.0.1:8000
- pi-session-memory: PI_SESSION_MEMORY_URL → PI_BACKEND_URL → http://127.0.0.1:8000
```

---

## 9. Known docs to fix / archive

### Archive / mark deprecated
- `docs/permission-gate.md` — extension not active; functionality merged into `simple-gate`.

### Rewrite
- `README.md` — replace install-centric text with local dev collection description.
- `docs/pi-skill-craft.md` — verify if skill-craft flow is still used; if not, archive.
- Extension-local `AGENTS.md` files (`pi-project-memory`, `pi-session-memory`, `sub-agents`) — strip down to extension-only template.

### Trim / consolidate
- `docs/pi-workflow.md` — good, but remove duplication of `AGENTS.md` rules; link instead.
- `docs/agent-nav.md` — update for new `docs/extensions/` paths and remove stale rows.
- `docs/patterns.md` — keep only actively used snippets.

### Keep as-is (after sanity check)
- `docs/pi-version-sync.md`
- `docs/pi-local-map.md`
- `docs/pi-tool-internals.md`
- `docs/tool-rendering.md`
- `docs/pi-quickref.md` (verify against current types)

---

## 10. Suggested session plan

### Session A — Foundation & AGENTS.md
1. Approve this outline.
2. Rewrite root `AGENTS.md` to the skeleton above.
3. Rewrite root `README.md` to match reality.
4. Move `docs/permission-gate.md` to `docs/archive/`.
5. Create `docs/git-policy.md`.
6. Update `docs/agent-nav.md` to point to new locations.

### Session B — Extension agent docs
1. Create `docs/extensions/<name>.md` for each active extension.
2. Each doc: purpose, commands/tools, critical notes, interactions, source link.
3. Start with the most intertwined: `context-guard`, `simple-gate`, `role-sw`, `model-manager`.

### Session C — Interactions & runtime map
1. Write `docs/interactions.md` from the wiring map above.
2. Document backend env resolution, settings.json keys, and tool-override ordering.
3. Add a troubleshooting section: "tool missing / prompt stripped / gate blocked".

### Session D — Cleanup & local AGENTS.md normalization
1. Strip extension-local `AGENTS.md` files to the standard extension-only template.
2. Trim duplicated content across docs.
3. Update `docs/patterns.md` and `docs/creating-extensions.md`.
4. Run `npm run typecheck` after any code moves.
5. Add a CHANGELOG note about doc reorganization.

### Session E — Tests (planned, not started)
1. Design lightweight Python-based unit/integration tests for cross-extension behavior.
2. Initial candidates:
   - `simple-gate` path classification and decision engine.
   - `context-guard` prompt-rule transformations.
   - `pi-multi-edit` edit batching/partial-apply logic.
   - 0x010 backend client mocks for `pi-web-search`, `pi-project-memory`, `pi-session-memory`.
3. Place tests under `tests/` or `scripts/tests/`.
4. Hook the test runner into a simple command (e.g., `python scripts/run-tests.py`).
5. Run tests alongside `npm run typecheck` for code changes.

---

## 11. Open questions to decide before Session A

- Should `AGENTS.md` mention Russian output language explicitly, or leave that to `role-sw`/`SYSTEM.md`?
- Should the root `README.md` stay bilingual or become English-only for consistency with code/docs?
- Do we want a `docs/archive/` folder, or simply delete deprecated docs and rely on git history?
- Is `auto-trust` behavior still current? (Needs quick read of `auto-trust/index.ts` before writing its doc.)
- Is `model-manager` config stored in `settings.json` or a separate file? (Needs quick read of `model-manager/config.ts`.)
- Commit prefixes: `[<ext-name>]` vs `ext(<name>):` vs other convention?
- Should we keep prefixed git tags (`context-guard-v0.2.1`) or skip tags entirely?
