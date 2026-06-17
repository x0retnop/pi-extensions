# Pi Extensions — Agent Workflow

One-page reference for maintaining this collection. No need to understand Node.js module resolution — just follow the rules.

## Two locations

| Location | Purpose | What lives there |
|---|---|---|
| `C:/10x001/pi extensions/` (this repo) | **Development** — editing, type-checking, git history. | All extensions + shared docs/scripts. |
| `~/.pi/agent/extensions/` | **Runtime** — Pi CLI loads extensions from here. | Only the extensions the user actively uses. |

**Rule:** edit in the dev repo first, then sync to `~/.pi/agent/extensions/`. Never edit directly in `~/.pi/agent/extensions/` unless it is an emergency one-liner.

## How dependencies work (simple version)

Pi CLI bundles its own core packages. When an extension runs inside Pi, these imports are **provided automatically** by Pi runtime:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`
- `typebox` / `@sinclair/typebox`

**Do not** install these into an extension folder. They are not needed at runtime.

### Dev type-checking setup

For `npx tsc --noEmit` to resolve `@earendil-works/*` types, the dev repo lists them as dev dependencies in the root `package.json` and installs them into the local `node_modules/` with `npm install`:

- `node_modules/@earendil-works/pi-coding-agent`
- `node_modules/@earendil-works/pi-ai`
- `node_modules/@earendil-works/pi-tui`
- `node_modules/typebox`

This means:
- `@earendil-works/*` **are** listed in the root `package.json` as `devDependencies`.
- When Pi CLI is updated globally, the local dev types are **not** automatically refreshed. Run `npm install` in the dev repo if you want the type-checker to match the new global version.
- If `node_modules` is stale, corrupted, or missing, recreate it from the repo root:
  ```bash
  cd "C:/10x001/pi extensions"
  rm -rf node_modules package-lock.json
  npm install
  npm run typecheck
  ```

### Regular npm dependencies

Some extensions need normal npm packages (e.g. `linkedom`, `@mozilla/readability`, `p-limit`). These are **not** bundled by Pi.

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
3. Copy changed files to `~/.pi/agent/extensions/<extension>/`.
   - Copy `package.json` if dependencies changed.
   - Copy `.ts` source files.
   - **Never** copy `node_modules/`.
4. If new regular npm dependencies were added, install them in `~/.pi/agent/` (see above).
5. Smoke-test the extension inside Pi (one command or tool call).

## Version sync after Pi CLI updates

See `docs/pi-version-sync.md`. The short version:
1. Run `python scripts/check-pi-sync.py`.
2. Decide whether the upgrade is worth it.
3. If yes, fix extensions in dev repo, type-check, sync, smoke-test.
4. Only then bump the `BASELINE` comment in `docs/pi-version-sync.md`.

## Runtime specifics

- `~/.pi/agent/SYSTEM.md` is intentionally **empty**. The active system prompt comes from **`role-sw`**, which loads role files from `~/.pi/agent/roles/`.
- Pi auto-loads `AGENTS.md` / `CLAUDE.md` from the **current working directory and all ancestor directories** up to the filesystem root. When the user launches Pi from `C:/10x001/pi extensions/`, this repo's `AGENTS.md` is injected, but any `AGENTS.md` / `CLAUDE.md` in parent directories is also injected. To keep only the file in `cwd`, use `context-guard` with the `ancestor-agents` rule.
- Extensions in `~/.pi/agent/extensions/` are loaded **once at startup**. After syncing dev → runtime, the user must **restart Pi** for changes to take effect.
- To inspect currently active extensions or gate/workspace settings, read `~/.pi/agent/settings.json` and list `~/.pi/agent/extensions/`. Do not edit these files directly unless asked.

## Golden rules

- One extension = one folder.
- Keep `@earendil-works/*` as `peerDependencies` with version `"*"` in `package.json`. Never pin to a specific version and never bundle them into `dependencies`.
- Do not commit `node_modules`.
- If an extension does not compile after a Pi update, check `docs/pi-version-sync.md` red flags first.
