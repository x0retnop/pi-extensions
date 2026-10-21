# Extension load and startup cost

Verified 2026-08-24 (load/perf session), 2026-09-20 (`.ts` vs `.js` session), 2026-09-20
(base-runtime memory + Node compile cache). Code wins if this drifts.

Startup wait is almost all **jiti compiling `index.ts` trees**, not `factory()` (0–4 ms) and not handler
“intertwining”. Pi creates a **new jiti per extension** with `moduleCache: false`, so `common/` is
recompiled for every importer. Same tax again in each `spawn_agent` child with `includeExtensions: true`.

## Base runtime (what is left under the extensions)

Measured 2026-09-20 on the live install (pi 0.84.4, Node v24.14.0). With extensions already at ~152 ms,
this is the floor underneath them: the live CLI was one 7.08 MB bundle whose **eager part (3.70 MB) was
re-parsed and evaluated on every start**. Since 1.0.1 the eager cost is the same order but split:
`cli-runtime.js` imports **15 chunks, ~3.59 MB eager** (15 MB of chunks total; the core chunk drops
from 3353 to 2624 KB with P-6 — see `docs/pi-local-map.md`).

**1.0.1 re-measure (2026-10-03):** `node dist/bundle/cli.js --version` = **241 ms** warm with
`NODE_COMPILE_CACHE` and P-6 applied (0.84.4 was 222 ms). Pi 1.0.1 also calls `enableCompileCache()`
itself in the bundle shim, so the host-wide variable is belt-and-braces rather than a requirement.
Modular `node dist/cli.js` stays in the same ratio as before (~1.0 s vs 0.24 s).

**`NODE_COMPILE_CACHE` is the one free lever.** Node ≥22.1 can persist the V8 code cache per module.
Set host-wide via `HKCU\Environment` (here: `C:\Users\user\.cache\node_js`):

| `node dist/bundle/cli.js --version` | ms |
|---|---|
| stock | 305 |
| + compile cache | 237 (−22%) |
| + compile cache + P-6 (catalog cut) | 222 (−27%) |
| node baseline | 29 |

Write behaviour (verified, not assumed): first run writes ~10 files / 1.8 MB, every later run is pure
read — no rewrite, no new files; a changed module rewrites only its own entry; a hard kill leaves no
temp files. One subdir per Node version (`v24.14.0-x64-<hash>`), so delete the root dir to reclaim;
`NODE_DISABLE_COMPILE_CACHE=1` is the off switch. It does **not** cover extensions — jiti runs those
through its own transform, not the module loader — but it covers the main chunk and everything loaded
later in a session (measured: cache dir grows with use).

**Env propagation trap (cost one round trip on 2026-09-20):** `setx` / `HKCU\Environment` only reaches
processes whose parent re-read the environment. Explorer refreshes on the change, but a terminal that
was already open keeps its old environment block and Pi inherits it — so a Pi started from an old pwsh
silently gets nothing. Before believing the numbers, check that the cache directory actually fills:
`ls $env:NODE_COMPILE_CACHE` empty after a start ⇒ the variable is not reaching Pi (open a new terminal).
To test from an existing shell: `Start-Process pwsh -UseNewEnvironment -ArgumentList '-NoProfile','-File',...`.

**Memory.** One full non-TTY start of the base runtime, no extensions: **67–68 MB RSS** (Node baseline
~40 MB). With the 17 extensions of that measurement (18 today): **89 MB**. Live processes: 109 / 176 / 269 MB — the growth is
session history and its rendering, not code. Cutting the runtime buys 2–3 MB; a fresh session buys 100+.

**Measuring without touching the live agent dir** (never start a second `pi` against it):

```bash
# full CLI module load + parse, exits immediately
node "$APPDATA/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" --version
# functional check after a catalog patch: throwaway agent dir + offline
PI_CODING_AGENT_DIR=<copy of auth.json/models.json/settings.json> PI_OFFLINE=1 pi --list-models
# memory: start with stdin redirected from an empty file (no TTY -> exits), sample RSS @200 ms
```

Probe caveat: a run with redirected stdin has no TTY, so Pi exits during `session_start` and a
pending `ui-theme` banner timer can throw "extension ctx is stale" and crash the process. That crash
inflates the last sample (one run showed 293 MB against a true 89 MB) — ignore any run whose peak comes
after the exit starts, or run it twice.

Eager vs lazy chunks, and what each one carries: `docs/pi-local-map.md`.

## The one big lever: ship `.js`, not `.ts`

Measured 2026-09-20 with `scripts/ext_load_bench.py` (same method, same cwd, A–Z, one process):

| tree | startup load |
|---|---|
| dev sources, 17 extensions, `.ts` | **1747 ms** |
| `_build/extensions`, same 17 compiled to `.js` | **152 ms** |

Registrations are identical (same event/tool/command counts per extension, 0 load errors). The first
run against a freshly written tree costs ~1450 ms (Defender scanning new files + cold transform
cache); every later run is ~152 ms because the transform cache is keyed by path and the runtime path
never changes.

**Cost is per module boundary, not per line.** Synthetic sets, one extension importing K helper
modules (identical code, same size):

| helper | 1 module | 4 | 8 | 16 |
|---|---|---|---|---|
| `.ts` | 18 ms | 49 | 101 | 195 |
| `.js` | 9 ms | 15 | 21 | 35 |
| same code inlined into `index.ts` | 7 ms (flat) | | | |

≈ 12 ms per `.ts` boundary, ≈ 0.9 ms per `.js` boundary, ≈ 0 inlined — a 705-line module costs the
same as a 66-line one, and `common/status.ts` (40 lines of code) is not cheaper than
`common/history-outline.ts`. With a warm jiti cache the `.ts` tree still pays 1831 ms (3642 ms with
`JITI_FS_CACHE=false`); the `.js` tree pays 165 ms (1540 ms cold).

Real A/B, `common/*.ts` → `common/*.js` only: a-rewind 25→12, role-sw 60→49, sub-agents 175→155,
context-guard 334→303, ui-theme 265→194 ms. Whole-tree compile subsumes this — there is no separate
`common/` step to do.

Two things must **never** land in the runtime:

| in the runtime | cost |
|---|---|
| a `.ts` file | full `.ts` path; and `index.ts` wins over `index.js` in `resolveExtensionEntries` |
| per-extension `package.json` (`"type":"module"`) | 809 ms: jiti tries Node's native ESM import, cannot resolve `typebox`/`@earendil-works` without `node_modules`, falls back to `eval_evalModule` |

## Measure

```bash
python scripts/ext_load_bench.py          # live ~/.pi/agent/extensions
python scripts/build-extensions.py        # dev .ts -> _build/extensions/*.js (skips when up to date)
python scripts/build-extensions.py --force # force tsc
python scripts/build-extensions.py --check # build to _scratch, write nothing
```

Read-only: Pi's `loadExtensions` only. No TUI, no `session_start`, no writes. Report:
`_scratch/ext-load-bench.txt`.

To time the compiled tree without deploying it, point `PI_CODING_AGENT_DIR` at a throwaway agent dir
whose `extensions/` is a copy of `_build/extensions` — copy it outside the repo, otherwise the repo's
`node_modules` lets the native-ESM path resolve and the numbers change.

Do **not** start a second `pi` against the live agent dir to time `session_start` — handlers write
`settings.json` / `model-manager.json` / `appendEntry`. Isolated `PI_TIMING=1` /
`PI_STARTUP_BENCHMARK=1` is Pi-builtin but still a full process (use a throwaway session dir if you must).

Do **not** bench runtime then dev in **one** Node process — the second pass is contaminated (looked
like a regression). Two processes, or `ext_load_bench.py` after sync.

## Deciding what to cut (usage census)

Load time is not the only axis. Before removing an extension, count what it actually did — one
session log proves nothing:

```bash
cd ~/.pi/agent/sessions
# tool calls, all sessions: how often each tool was really invoked
rg -o --no-filename '"toolName":"[a-z_]+"' --glob '*.jsonl' . | sort | uniq -c | sort -rn
# custom session entries: per-session writes by an extension, NOT usage
rg -o --no-filename '"customType":"[a-z_-]+"' --glob '*.jsonl' . | sort | uniq -c | sort -rn
```

Read the second list carefully — a `*-state` entry is written on every `session_start` (e.g.
`session-memory-state` in 812 sessions) and looks like activity while the feature is idle. The 2026-09-20
census killed `pi-session-memory`'s agent half: `session_memory` had 62 calls all-time, its
backend service was not listening, and the tool was already gated off — while the extension cost
131 ms of load and a per-turn `before_agent_start` settings re-read.

The other fixed cost is **per request, not per start**: the tool schema (18.5 KB for 12 tools, ~78 % of
the 23.6 KB static prefix; the system prompt was 5.0 KB) travels with every call. Only cutting tools
removes it — capture one request with `/payload-trace` and weigh `tools` against `messages[0]`
(see `docs/extensions/payload-trace.md`).

## What actually runs

```
discover ~/.pi/agent/extensions (A–Z, index.ts then index.js)
  → jiti import + factory()          # PI_TIMING / ext_load_bench
  → TUI first paint (header)
  → ensureTool fd + rg
  → bindExtensions → session_start   # not in the bench
  → renderInitialMessages
  → setTimeout(0) ui-theme splash + context-guard ribbon (20 ms fallback)
```

Faster compile makes the **post-paint** stretch visible (“two stages”). Total can be lower while it
*feels* heavier. That stretch is Pi + `session_start`, not leftover TUI compile.

`session_start` reasons `startup` / `new` / `resume` / `fork` each get a **new ModelRuntime** (main
`createRuntime` does not reuse it). `/reload` and `session_tree` keep the same runtime.

## Already done (do not redo)

| Change | Effect |
|---|---|
| Whole-tree compile to `.js` (`scripts/build-extensions.py` + `sync-extensions.ps1`) | 1747 → 152 ms |
| Dynamic `import()` of command-only TUI (`/mm`, `/context-guard`, `/ui-theme`, `/sub-agents`, `/web`; session viewer) | jiti does **not** evaluate those modules until the command. `import type` is erased. Probe: no top-level log in `tui.ts` on load |
| `applyCuratedRegistrations` memo (`provider-utils.ts`) | First apply: `register` only. Same fingerprint: skip. `unregister` only when replacing or dropping a previous apply in this factory |
| No model-manager `session_tree` apply | Tree does not change providers |
| pi-session-memory backend removed (2026-09-20) | 6 files / 3456 → 2668 lines, 0 events, 0 tools; was a per-turn `before_agent_start` settings re-read + `session-memory-state` entry in every session |
| context-guard `sessionMemory` gate removed | Dead toggle gone with the tool |
| Host-wide `NODE_COMPILE_CACHE` (2026-09-20) | Base CLI start 305 → 237 ms (−22 %); extensions unaffected (jiti does not go through the module loader) |
| Runtime patch P-6 — blank the 35 unused built-in provider catalogs (2026-09-20) | Eager chunk 3646 → 3190 KB; start 283 → 222 ms together with the compile cache |
| Base-runtime memory census (2026-09-20) | 67–68 MB RSS without extensions, 89 MB with them; live processes 109–269 MB is session history, not code — stop looking for code cuts |

`unregisterProvider` on a fresh runtime is **not** free: delete + `recompose` + `updateModelSnapshot` +
`void refresh({allowNetwork:false})`, then `register` does it again. `registerProvider` already
overrides built-ins (merge of defined fields).

## Still paid at factory / first paint

- **context-guard** still static-imports `overview.ts` (`registerContextOverview` needs `tool_result` at factory; TUI lives in the same file).
- **pi-session-memory** still static-imports `session-browser.ts` (`browseItemFrom*` are values in the TUI file).
- **ui-theme** footer/rate/turnlog/banner stay eager — needed on `session_start`.
- **model-manager** `session_start` still `repairManagedCaches` + first `register` (no `setModel` — Pi applies `settings.json` `defaultProvider`/`defaultModel` itself before extensions load).
- Boot chrome: `ui-theme/splashIfEnabled` `setTimeout(0)`, context-guard ribbon fallback 20 ms — designed so notify lands after history, looks like a second wave.

## Next cuts (only if asked)

Lazy-split is cheap when the **command** is the only consumer. Do not split a file if a
`session_start` / `tool_result` handler still needs a value export from it (that pulls the TUI back).
With the tree compiled, the remaining lever is **bundling** each extension into a single `.js`
(every boundary gone), which would need esbuild and a source-map story — a build-step change, not an
extension tweak.

Per-event ms needs a **runner `emit()` wrap** (runtime patch, like P-1…P-6) or bookend extensions
(total only). Do not fire real `session_start` from a bench against live `~/.pi/agent`.
