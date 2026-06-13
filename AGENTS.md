# AGENTS.md

Quick context for agents working in this repo.

## What this is

This is a **development collection** of Pi Coding Agent extensions.
`C:/10x001/pi extensions/` is the dev workspace. The user edits and develops extensions here.

Active extensions are **manually copied** by the user to the Pi runtime folder:
`C:\Users\user\.pi\agent\extensions\` (or `~/.pi/agent/extensions/`).
They are **not** installed via `pi install`.

## Critical workflow rules

- **Edit here** (`C:/10x001/pi extensions/`).
- **Runtime is elsewhere** (`~/.pi/agent/extensions/`). Pi only loads from there.
- After editing, the user copies the folder manually and **restarts Pi**.
- Do **not** test freshly edited extensions via bash — they are not loaded yet.
- Do **not** edit `~/.pi/agent/extensions/` directly unless the user explicitly asks.
- Do **not** tell the user to copy/restart unless they ask or the task explicitly requires runtime verification.

## Type-checking extensions

Only type-check after editing **code** (`.ts`, `.js`, `.tsx`, `.jsx`, `.json` files such as `package.json`). There is no need to run `tsc` for documentation-only changes (`.md`, `.txt`, etc.).

Run this from the repo root to verify all included extensions compile:

```bash
cd "C:/10x001/pi extensions"
npx tsc --noEmit
```

Why this works:
- `tsconfig.json` in this repo lists every active extension in `include`.
- Pi core packages (`@earendil-works/*`) are resolved through symlinks in `node_modules/@earendil-works/`, which point to the globally installed Pi CLI.
- `typebox` is a local `devDependency` in this repo.

Do **not** run `npx tsc --noEmit <files>` with explicit file arguments unless you also pass `--ignoreConfig` — otherwise the project-wide type resolution is bypassed and Pi core imports will fail. Prefer `npx tsc --noEmit` from the repo root.

If a single extension has errors that are hard to read in the full project output, you can type-check just that extension while keeping the config:

```bash
cd "C:/10x001/pi extensions"
npx tsc --noEmit --ignoreConfig --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --types node pi-extension-folder/index.ts
```

## Runtime dependencies reminder

If you add a **new extension** or **new runtime dependency** to an existing extension:

1. Add the npm package to the extension's `package.json` `dependencies`.
2. After the user copies the extension to `~/.pi/agent/extensions/`, the dependency must be installed in the shared runtime:
   ```bash
   cd ~/.pi/agent
   npm install <package>
   ```
3. Do **not** create a `node_modules/` inside the extension folder.

Pi core packages (`@earendil-works/*`, `typebox`) are provided by Pi CLI at runtime — never list them as `dependencies`.

## Checking Pi CLI version compatibility

When the user asks about upgrading Pi, version compatibility, or whether to update:

1. **First** run `python scripts/check-pi-sync.py` from the repo root.
2. **Then** read `docs/pi-version-sync.md` and follow its workflow.
3. **Only if** the script flags something or the CHANGELOG delta is unclear — use web search or fetch the full release notes for clarification.

**Do NOT start with web search.** The local script is the single source of truth for what is actually installed and what patterns exist in this collection.

## When you are unsure — follow this order

1. **Check agent docs first.** Look at the tables in this file and `docs/agent-nav.md` for the topic.  
   Docs in `docs/` are written for agents and cover workflow, API, patterns, and known pitfalls.
2. **If the doc points to source, go there.** Some answers live in `.d.ts` files (`dist/core/**/*.d.ts`) or Pi runtime JS (`dist/core/tools/*.js`).
3. **Only then search the web or guess.** Local docs are the single source of truth for this collection.

## Where to look

| If you need... | Look at... |
|---|---|
| Dev vs runtime rules, sync, dependencies | `docs/pi-workflow.md` |
| API types, events, UI | `docs/pi-quickref.md` |
| Providers, models, auth, adding custom models | `docs/pi-providers-models.md` |
| Where Pi types live locally | `docs/pi-local-map.md` |
| What to check after Pi CLI update | `docs/pi-version-sync.md` |
| Pi changelog / release notes | `https://pi.dev/changelog` |
| Create a new extension | `docs/creating-extensions.md` |
| Copy-paste snippets | `docs/patterns.md` |
| Current active extensions / settings | `~/.pi/agent/extensions/`, `~/.pi/agent/settings.json` |
| Custom tool rendering (renderCall / renderResult pitfalls) | `docs/tool-rendering.md` |
| Lost? Not sure which doc to open | `docs/agent-nav.md` |

## Style

- One extension = one folder. Minimal, no frameworks.
- Keep `@earendil-works/*` as peer deps.
- Do not mass-format or rename without request.
