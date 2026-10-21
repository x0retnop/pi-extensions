# Pi Extensions — Agent Workflow

One-page reference for maintaining this collection. No need to understand Node.js module resolution — just follow the rules. Extensions are **not** installed via `pi install` from this workspace.

## Two locations

| Location | Purpose | What lives there |
|---|---|---|
| `C:/10x001/pi extensions/` (this repo) | **Development** — editing, type-checking, git history. | TypeScript sources + shared docs/scripts. |
| `_build/extensions/` | **Compiled** — what actually gets deployed (`.js` + assets, no `.ts`, no `package.json`). Gitignored, rebuilt on every sync. | Flat extension folders. |
| `~/.pi/agent/extensions/` | **Runtime** — Pi CLI loads extensions from here. | The compiled tree, only the extensions the user actively uses. |

**Rule:** edit in the dev repo first, then `sync-extensions.ps1` builds and deploys. Never edit directly in `~/.pi/agent/extensions/` unless explicitly asked.

**Why the runtime holds `.js`, not `.ts`:** Pi loads every extension through its own jiti instance
(`moduleCache: false`), so each `.ts` module boundary costs ~12 ms of babel TS transform at startup
while the same file as `.js` costs ~0.9 ms. Measured with `scripts/ext_load_bench.py`: **1747 ms →
~152 ms** for 17 extensions, identical registrations. Two things must never land in the runtime: a
`.ts` file (Pi prefers `index.ts` over `index.js`, so the source would win) and a per-extension
`package.json` with `"type": "module"` (jiti tries Node's native ESM import first, fails to resolve
`typebox`/`@earendil-works` without `node_modules`, falls back — 809 ms instead of 152 ms). See
`docs/ext-load-perf.md`.

## How dependencies work (simple version)

Pi CLI bundles its own core packages. When an extension runs inside Pi, these imports are **provided automatically** by Pi runtime:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`
- `typebox` / `@sinclair/typebox`

**Do not** install these into an extension folder. They are not needed at runtime.

### Dev type-checking setup

`tsc` / unit tests resolve `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` through **directory junctions** in this repo's `node_modules/@earendil-works/` that point at the **global** Pi CLI (`%APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent` and its nested `pi-ai` / `pi-tui`). Same copy the runtime loads. `typebox`, `typescript`, and `@types/node` stay real local `devDependencies`.

**Why not `npm i @earendil-works/pi-coding-agent` here:** that package's shrinkwrap pulls ~200MB of provider SDKs (OpenAI/Google/OTel/…) that typecheck never opens (`skipLibCheck`). A second copy also drifts from the installed CLI.

**Do not:**
- Add `@earendil-works/*` to the root `package.json` `devDependencies` / `dependencies`.
- `npm install` those packages into this repo or any extension folder.
- `rm -rf` a junction in a way that follows the link (can wipe the global CLI). Recreate with the linker, not by installing a fat copy.
- `npm install --ignore-scripts` in this repo (skips the linker).

After a global Pi CLI update, types match automatically (junction). No extra `npm install` of Pi packages.

If `node_modules` is stale, missing, or `tsc` cannot resolve `@earendil-works/*`:
  ```bash
  cd "C:/10x001/pi extensions"
  npm install
  python scripts/link-pi-from-global.py --check
  npm run typecheck
  ```
`npm install` runs the linker as `postinstall`. Re-link only: `python scripts/link-pi-from-global.py`. Only delete `package-lock.json` when lockfile deps actually changed.

### Regular npm dependencies

Some extensions need normal npm packages (e.g. `p-limit`). These are **not** bundled by Pi.

They are installed once in the shared runtime directory:

```
~/.pi/agent/node_modules/     <-- shared for all extensions
```

Managed by `~/.pi/agent/package.json`.

**If you add a new regular dependency to an extension:**
1. Add it to the extension's `package.json` `dependencies` in the dev repo.
2. After syncing to `~/.pi/agent/extensions/`, install it in the shared runtime:
   ```bash
   cd ~/.pi/agent
   npm install <package>
   ```
3. Do **not** create a `node_modules` folder inside the extension directory.

## Sync checklist (dev → runtime)

1. Edit code in `C:/10x001/pi extensions/<extension>/`.
2. Run `npm run typecheck` from the repo root to verify types.
3. `python scripts/build-extensions.py` — compiles every extension + `common/` to `_build/extensions/`
   (ESM `.js`), copies non-TS assets, skips `package.json`. **Incremental, three levels:** nothing
   changed → ~0.4 s and tsc never starts; only assets changed → no tsc, just the changed assets;
   `.ts` changed → `tsc --incremental` re-emits the changed files and their dependents only, and
   removed sources have their `.js` swept. A stamp of every source/asset + `tsconfig.build.json` +
   the script itself decides this; `--force` overrides, `--check` builds to `_scratch/` instead.
4. `pwsh -File ./sync-extensions.ps1` — builds (step 3 runs inside), then mirrors `_build/extensions/`
   into `~/.pi/agent/extensions/`: copies by content hash, and **deletes stale `.ts` / `package.json`**
   that the compiled tree does not have. Files that only exist in the runtime (notes, extra docs) are
   left alone. `-WhatIf` previews, `-NoBuild` reuses the last build, `-RuntimePath` points elsewhere.
   **Agents add `-NoWait`.** Without a console the script detects the redirected streams and skips the
   keypress itself, but `-NoWait` is the explicit contract — it also suppresses the self-kill that
   closes a manually launched window (that kill would eat the caller's exit code).
5. Restart Pi — extensions load once at startup.
6. Smoke-test the extension inside Pi (one command or tool call).

Consequences of the compiled runtime: stack traces, `/payload-trace` dumps and error paths point at
`.js` (source maps are off), while types still come from the `.ts` sources. Debug from the dev repo —
edits there are what the next build picks up; anything edited in `_build/` is overwritten.

**Never hand-copy `.ts` into the runtime.** A stray `index.ts` next to `index.js` silently wins and
puts the slow path back. Deploying a new extension stays the user's call: the sync only updates folders
that already exist in the runtime and reports the rest as "built but not deployed".

## Version sync after Pi CLI updates

See `docs/pi-version-sync.md`. The short version:
1. Run `python scripts/check-pi-sync.py`.
2. Decide whether the upgrade is worth it.
3. If yes, fix extensions in dev repo, type-check, sync, smoke-test.
4. Only then bump the baseline in `docs/pi-version-sync.md`.

## Runtime specifics

- `~/.pi/agent/SYSTEM.md` is a short **alarm canary** (copy `role-sw/SYSTEM.md`). Non-empty so Pi skips its default persona. `role-sw` strips it and puts the role first; if role-sw does not load, the model must reply with the alarm line.
- Stock Pi auto-loads `AGENTS.md` / `CLAUDE.md` from cwd and all ancestors. **This host disables that** (runtime P-3). `context-guard` injects only `cwd/AGENTS.md` as the first hidden message on an empty session (`agentsInject`).
- Extensions in `~/.pi/agent/extensions/` are loaded **once at startup**. After syncing dev → runtime, the user must **restart Pi** for changes to take effect.
- To inspect currently active extensions or gate/workspace settings, read `~/.pi/agent/settings.json` and list `~/.pi/agent/extensions/`. Do not edit these files directly unless asked.

## Golden rules

- One extension = one folder.
- Keep `@earendil-works/*` as `peerDependencies` with version `"*"` in `package.json`. Never pin to a specific version and never bundle them into `dependencies`.
- Do not npm-install `@earendil-works/*` into this repo (junctions to the global CLI — see type-checking setup above).
- Do not commit `node_modules`.
- If an extension does not compile after a Pi update, check `docs/pi-version-sync.md` red flags first.
