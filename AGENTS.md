# Pi Extensions — Agent Guide

Dev workspace for Pi Coding Agent extensions. Code is edited here and deployed to the runtime (`~/.pi/agent/extensions/`) with `sync-extensions.ps1` (builds `_build/extensions/`, then mirrors it); the user restarts Pi — fresh code cannot be tested via bash. Not installed via `pi install`.

## Start here

1. **`docs/off-doc-llm/INDEX.md`** — LLM-adapted Pi docs; first stop for Pi behavior, APIs, config. Runtime code (`@earendil-works/pi-coding-agent`, npm global) only if the off-doc doesn't answer. Path map for that case: `docs/pi-local-map.md`.
2. `npm run typecheck` — gate for `.ts` / `package.json` changes before committing. Markdown/docs-only edits skip it — tsc can't read prose, don't run gates "чтобы было". Read other docs only when the task touches their area (Docs table).
3. **`docs/extensions/INDEX.md`** — what each extension is (and archived ones), plus §Commands, the single list of every slash command. Behavior: `docs/extensions/<name>.md`.

This file is a shortcut, not a mirror — if it does not answer a question, explore the repo; the code is the source of truth.

## Map

| Area | Path | Notes |
|---|---|---|
| Extensions | `<name>/` | one folder = one extension, flat; entry `<name>/index.ts` |
| Shared TS helpers | `common/` | chrome / status / paint / history-outline; not an extension |
| Skills, themes | `skills/`, `themes/` | dev copies, synced manually to `~/.pi/agent/` |
| Roles | `~/.pi/agent/extensions/role-sw/roles/` | **runtime only** — role prompts are edited and versioned there, never checked in (the repo's `role-sw/roles/` is empty and git-ignored; sync prunes only `.ts`/`package.json`, so it never touches them) |
| Unit tests | `tests/unit/` | run via `python scripts/run-tests.py` |
| Scripts | `scripts/` | test runner, Pi version check, session forensics |
| Archive | `_archive/` | retired extensions + their docs — gitignored, not scanned; catalog + retirement procedure in `_archive/INDEX.md` |
| Compiled extension tree | `_build/extensions/` | gitignored output of `scripts/build-extensions.py` — what `sync-extensions.ps1` deploys (`common/` is compiled in the same pass) |
| LLM-adapted docs | `docs/off-doc-llm/` | **TYPES.md**, **EXTENSIONS.md**, etc. — preferred over runtime spelunking |

Do not scan: `node_modules/`, `_build/`, `.tests-out/`, `_scratch/`, `mcps/`, `_archive/` — open a file there only if the user names it. `_build/` holds compiled `.js` twins of the sources; edits there are overwritten by the next build.

## Commands

```bash
# run from repo root
npm run typecheck                # .ts/package.json changes only — skip for docs-only commits
python scripts/build-extensions.py         # dev .ts -> _build/extensions/*.js (deploy source; sync runs it too); incremental — skips when nothing changed, --force/--check
pwsh -NoProfile -File ./sync-extensions.ps1 -NoWait   # deploy _build/extensions -> ~/.pi/agent/extensions (existing folders only); AGENTS: always pass -NoWait — a manual run keeps the keypress pause and the window self-close
python scripts/run-tests.py                # unit tests — when changing code covered by tests/unit/, not by default
python scripts/run-tests.py session-memory # substring or tests/unit/*.test.ts
python scripts/check-pi-sync.py  # after a Pi CLI update, before version refactors
python scripts/link-pi-from-global.py --check  # if tsc cannot resolve @earendil-works/*
python scripts/ext_load_bench.py # read-only timing of live ~/.pi/agent/extensions load
python scripts/pi_session_inspect.py --summary --since 7   # session-log forensics
python scripts/session_triage.py # classify ~/.pi/agent/sessions (lifecycle, not health)
python scripts/session_usage_stats.py --week last  # spend/time/volume by plan, project, day -> reports/session-usage/
python scripts/provider_inject_probe.py --target provider-a --quote  # provider tape vs JSON (see docs/scripts/provider_inject_probe.md)
python scripts/role_alias_migrate.py  # rewrite stored role names to family aliases (dry-run; --apply writes + backs up)
python scripts/pi_runtime_decat.py        # P-6b runtime patch: blank unused built-in model catalogs in the live bundle (dry-run; --apply / --revert)
python scripts/pi_runtime_patches.py     # P-2..P-10 after a Pi upgrade: anchors asserted, dry-run; --apply writes (*.backup-*-hostpatch)
python scripts/publish_public.py          # public snapshot dry-run: file list, tree sha, leak scan (never pushes)
python scripts/publish_public.py --push --confirm <tree-sha> [--fresh]   # push — only after the operator reviewed that tree
```

## Rules

- Edit only inside this repo. Never edit `~/.pi/agent/` (extensions, settings) unless explicitly asked.
- The runtime loads compiled `.js` from `_build/extensions/` (see `docs/pi-workflow.md`). Never hand-copy `.ts` or a per-extension `package.json` into the runtime — both restore the slow startup path.
- Never enable, disable, add or delete an extension — that is the user's call. `sync-extensions.ps1` is the sanctioned mirror (updates existing folders; reports new ones as "built but not deployed"). **Retiring is an agent task when asked** — follow `_archive/INDEX.md` §"Retiring an extension": zip/move the folder, move its doc to `_archive/docs/`, fix the catalog, and re-home anything it uniquely owned (a settings key, a patch, a tool name).
- `@earendil-works/*` and `typebox` stay `peerDependencies` with `"*"`; regular npm deps install in `~/.pi/agent/`, never in extension folders.
- Do not `npm i @earendil-works/*` into this repo. Root `node_modules/@earendil-works/` is junctions to the global Pi CLI (see `docs/pi-workflow.md`). Recreate with `npm install` or `python scripts/link-pi-from-global.py`.
- Do not mass-format or rename without request.

## Docs

| Doc | Read when |
|---|---|
| `docs/burned.md` | Before risky edits; areas with past failures (scroll, rendering, build/deploy, tooling) |
| `docs/off-doc-llm/INDEX.md` | **First stop** for Pi behavior, API, config |
| `docs/off-doc-llm/EXTENSIONS.md`, `TYPES.md` | extension events/tools/commands/UI; all TS types — **API owners** |
| `docs/pi-workflow.md` | dev vs runtime, dependency rules, sync checklist |
| `docs/pi-update-check.md`, `pi-version-sync.md`, `runtime-patches.md` | **first session after a Pi CLI update** — checklist, compatibility, re-apply P-1…P-10 (P-1 and P-5 site 1 are settings since 0.99/0.84.4, not code) |
| `docs/provider-ua-notes.md`, `provider-quota-notes.md` | before touching the provider UA or reading `/usage` ≈$ |
| `docs/provider-oauth-notes.md`, `provider-quota-2.md` | before touching provider auth or `/usage` ≈$ |
| `docs/pi-local-map.md` | installed source / types / shipped docs paths (after off-doc) |
| `docs/pi-tool-internals.md`, `pi-internals.md` | tool visibility, `setActiveTools()` timing, parallel batches; prompt construction, message flow, retry |
| `docs/pi-reasoning-context.md` | model "knows" in reasoning but denies it in the reply; Pi replay of thinking blocks |
| `docs/roadmap.md` | deferred decisions/ideas before starting work on one — the tool-row revision plan (remaining rows + the recipe) lives here |
| `docs/decisions.md` | before reopening a settled question (why a feature is off, why an override is named that way, why deploy works like this) — the *reason* lives here, the fact in its owner doc |
| `docs/pi-features.md` | which Pi platform features this host uses / ignores and why — check before assuming a feature is missing, active, or worth enabling |
| `docs/pi-provider-payloads.md`, `pi-providers-models.md` | request payloads (assistant-prefill replay + completions trap); models.json, custom providers, custom setup; **catalog gaps** (invented contextWindow / lost vision) + models.dev |
| `docs/pi-quickref.md` | map of the "how to write an extension" surfaces — which doc owns what |
| `docs/pi-extension-gotchas.md`, `tool-rendering.md` | hard-earned pitfalls; renderShell / renderCall / renderResult |
| `docs/ext-load-perf.md` | startup/jiti cost, `ext_load_bench.py`, lazy TUI, usage census — before more load/perf work or deciding what to cut |
| `docs/interactions.md` | cross-extension wiring, tool overrides, load order, troubleshooting |
| `docs/creating-extensions.md`, `docs/patterns.md` | new-extension scaffold, copy-paste snippets |
| `docs/pi-network-runtime.md`, `docs/local-backend.md` | proxy/VPN/timeout diagnosis; start/stop the local backend service |
| `docs/pi-skill-craft.md` | writing skills for context-guard `/use-skill` |
| `docs/scripts/pi_session_inspect.md`, `session_triage.md`, `session_usage_stats.md` | session-log forensics; session lifecycle/quarantine; spend/time rollups vs subscription |
| `docs/scripts/provider_inject_probe.md` | HTTP JSON vs compiled tape; measured per-provider injects; `provider_inject_probe.py` |
| `docs/local-agent-eval.md` | swapping/evaluating a local model as a Pi agent: state checks, the Agent API swap, gateway presets, the eval loop |
| `docs/extensions/INDEX.md`, `docs/extensions/<name>.md` | catalog + per-extension behavior |
| `docs/publishing.md` | publishing to the public repo: snapshot branch, ignore/scrub/scan files, confirm-push gate, force-push caveats |
| `docs/research/` | background only, read when a topic sends you there: `sys-prompt-qa.md` (cross-harness primer), `cache-miss-research.md` (cache-miss investigation), `uncensored-model-apis.md` |

Doc rules: English, LLM-only, lead with the non-obvious fact — a line earns its place only if one command could not rediscover it, so code-obvious restatement and file listings do not belong. The slash-command surface has one owner, `docs/extensions/INDEX.md` §Commands — per-extension docs carry no command lists, no `## Commands` section, no tool schema (the model already receives the description). If a doc contradicts the code, the code wins — fix or delete it right then. No STATUS/notes/diary files; deferred decisions go in `docs/roadmap.md`, settled decisions and their reasons in `docs/decisions.md`, work state in commit messages. A cross-doc link means "X owns this" — never a second copy of the fact.

## Quick context

- Host-level env in `HKCU\Environment`: `NODE_COMPILE_CACHE=C:\Users\user\.cache\node_js` (V8 compile cache for every Node process — see `docs/ext-load-perf.md`), `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1`. `PI_CACHE_RETENTION` was removed 2026-09-25 — it was a no-op on every chain in use (some upstreams accept-and-ignore the field, completions proxies ignore it) while strict upstreams 400 on it; the private provider notes have the per-model fix recipe. A terminal opened before a change keeps the old env block — verify with a fresh one (`ls $env:NODE_COMPILE_CACHE`). Offline blocks Pi's self-update and the remote catalog refresh, so clear it for that one command (`set PI_OFFLINE=` / `npm i -g`).
- This host does not glue `AGENTS.md` into the system prompt (runtime P-3). `context-guard` injects `cwd/AGENTS.md` once as the first hidden message on an empty session (`agentsInject`, default ON). `SYSTEM.md` is a **short alarm canary** (not a persona): non-empty so Pi skips its default prompt. `role-sw` strips it and injects the role. If a model sees `ROLE_SW_REQUIRED`, role-sw did not load — it must reply with the one-line alarm and stop.
- Tool overrides: `read-mode` → `read`, `pi-multi-edit` → `edit` (+ `multi_edit`, `insert`), `grep-tool` → `grep`. `pi-agent-run` adds `pwsh` and `py` (bypass Git Bash quoting). `simple-gate` can block/ask `read`/`write`/`edit`/`bash` — not `pwsh`/`py`.
- Web: live runtime uses `web-search-st` (no backend service). `pi-web-search` is archived (`_archive/pi-web-search.zip`) — do not resurrect it alongside `web-search-st` (same tool names, `/web`, `web-access-state`). `pi-session-memory` is local-only (`/sw` browser + Markdown export) — no backend service, no agent tool.
- TUI chrome hub: `ui-theme` (footer/rate/banner/working/presets/turn log; `/ui-theme`, `/timestamps`). New preset = JSON in `ui-theme/presets/` — see `docs/extensions/ui-theme-presets.md`. Status producers stay in a-rewind / role-sw / sub-agents.

## Git

Agent-owned working memory: local-only history for checkpoints and recovery; the user does not rely on it. `main` is **never** pushed — the public repo (`origin`) gets a filtered snapshot branch instead, `docs/publishing.md`.
- No rebase, amend, or reset of existing commits, and never `git fetch`/`add remote`.
- The only outbound path is `scripts/publish_public.py`: it builds `public` from `HEAD` minus `publish-ignore.txt`, rewrites by `publish-scrub.txt`, leak-scans by `publish-scan.txt`, and pushes to `origin/main` only with `--confirm <tree-sha>` after the operator has seen that dry-run list. Never `git push` by hand, never `--no-verify`-style bypasses, never approve your own list.
- Commit after a verified chunk of work, and before risky edits. Not on every save.
- Message prefix = area: `[root]`, `[docs]`, `[scripts]`, `[<ext>]`; split multi-area changes into separate commits by area (when easy).
- Never commit `node_modules/`, zips, logs, or temp files; lockfiles only when deps change — keep `.gitignore` current.
