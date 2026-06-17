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

Type-checking tells you whether the extension source is compatible with the Pi API types declared in the local `node_modules`.

Run the project type-check from the repo root:

```bash
cd "C:/10x001/pi extensions"
npm run typecheck
# or equivalently:
# npx tsc --noEmit
```

What this checks:
- All active extensions listed in `tsconfig.json` `include`.
- All imports against `node_modules/@earendil-works/*`, `typebox`, and `@types/node`.
- `npm run typecheck` and `npx tsc --noEmit` are equivalent; use whichever you prefer.

What it does **not** check:
- Runtime behavior inside Pi.
- Whether the extension loads correctly after copy/restart.
- Whether runtime npm dependencies are installed in `~/.pi/agent/`.

### When type-checking fails

1. Read the error path and message.
2. If the error is about a missing property or changed event shape, the installed Pi API types have diverged from the code. Fix the code to match the type.
3. If the error mentions broken `node_modules/@earendil-works/*` resolution, the local dev dependencies may be stale or corrupted. Recreate them:
   ```bash
   cd "C:/10x001/pi extensions"
   rm -rf node_modules package-lock.json
   npm install
   npm run typecheck
   ```

### Checking a single extension

If a single extension has errors that are hard to read in the full project output, you can type-check just that extension while keeping the same compiler settings:

```bash
cd "C:/10x001/pi extensions"
npx tsc --noEmit --ignoreConfig --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --types node pi-extension-folder/index.ts
```

This bypasses `tsconfig.json` `include`, so you must pass the full compiler flags manually.

## Dependencies

### Dev dependencies (root `package.json`)

The root `package.json` lists only dev-time dependencies needed for type-checking:

- `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` — Pi API types.
- `@types/node` — Node.js built-in types.
- `typebox` — schema types used by Pi tools.
- `typescript` — compiler.

These are installed into the local `node_modules/` by `npm install`.

### Extension dependencies

Each extension is a Pi package. It should use `peerDependencies` for Pi core packages:

```json
"peerDependencies": {
  "@earendil-works/pi-coding-agent": "*",
  "typebox": "*"
}
```

If an extension needs a normal npm package at runtime (e.g. `p-limit`):

1. Add it to the extension's `package.json` `dependencies`.
2. After the user copies the extension to `~/.pi/agent/extensions/`, install it in the shared runtime:
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
