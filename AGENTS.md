# AGENTS.md

Context for agents working in this repository. Goal: understand the project quickly without wasting context on noise.

## What this project is

This is a collection of extensions for **Pi Coding Agent**: <https://pi.dev/docs/latest>.

Pi is a minimal terminal coding harness extended via TypeScript modules, skills, prompt templates, themes, and pi packages. Extensions can:

- Register tools for the model via `pi.registerTool()`;
- Add slash commands via `pi.registerCommand()`;
- Subscribe to lifecycle, session, message, tool call/result events;
- Block/modify tool calls, inject context, manage compaction/session flows;
- Interact with the user via `ctx.ui` (`notify`, `confirm`, `select`, custom TUI);
- Store state via session entries and the session manager.

This repository is not a single app — it is a set of standalone pi packages. Almost every top-level directory with a `package.json` is a separate installable package via `pi install ./folder` or git/npm.

## Repository layout

Root:

- `package.json`, `tsconfig.json` — dev environment for TypeScript-checking the whole collection.
- `README.md` — public catalog of extensions and install examples.
- `commanddb.json` — data for permission gate / command DB.
- `_test_*.py`, `_proof.py`, `_temp_checkdb.py` — old/manual check scripts; do not treat them as architecture unless necessary.
- `node_modules/` — installed environment; do not edit.
- `nul` — Windows/shell artifact; ignore unless requested.
- `docs/` — agent-facing docs: `pi-local-map.md`, `pi-quickref.md`, `creating-extensions.md`, `patterns.md`.

Main packages:

- `a-rewind` — guards against assistant messages that promise tool use without real tool calls; manual rewind of the latest assistant message.
- `asku` — interactive `ask_user_question` tool for clarifying questions via TUI.
- `btw` — `/btw` for quick side questions with bounded context, without writing Q/A into session history.
- `context` — shows loaded context files, extensions, skills, tools, and approximate token usage.
- `ctx-manager` — `/ctx`, manual context helper with toggles, compaction, and handoff helpers.
- `grep-tool` — grep search tool extension.
- `handoff` — generates a focused handoff prompt and helps switch to a new session.
- `ollama-cloud-web` — adds `web_search` and `web_fetch` tools via Ollama Cloud.
- `permission-gate` — safety gate for `bash/read/write/edit`: structural command analysis, path guard, protected roots, strict/balanced/relaxed/yolo modes.
- `pi-docs-toggle` — toggles Pi docs context.
- `sessions` — `/sessions`, interactive lazy-loading picker for Pi sessions.
- `tm` — temperature/model utility extension.
- `todo` — model-callable todo checklist tool, `/todos`, `/todo-mode`.

## Collection style

Intentionally minimalist:

- one extension = one folder;
- inside the folder: code, `package.json`, and a short, clear `README.md`;
- description should explain what the extension does, how to install/enable it, and what commands/tools it adds;
- no long marketing, no unnecessary architecture prose, no big examples unless needed;
- root `README.md` is a minimal catalog of ready extensions, not detailed code docs.

## Typical extension package

Usually looks like this:

```text
some-extension/
  index.ts          # entry point, default export function(pi: ExtensionAPI)
  package.json      # name, peerDependencies, pi.extensions
  README.md         # short public description
```

Larger packages are split into modules:

- `handoff`: `config.ts`, `extraction.ts`, `metadata.ts`, `parser.ts`, `progress.ts`, `prompt.ts`, `types.ts`.
- `permission-gate`: `analyzer.ts`, `engine.ts`, `path-guard.ts`, `inline-scan.ts`, `tokenizer.ts`, `command-db.ts`, `types.ts`.

Typical `package.json`:

```json
{
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

Pi dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) must remain peer dependencies unless there is an explicit reason to change packaging.

## Key Pi concepts for edits

- An extension exports a default factory: `export default function (pi: ExtensionAPI) { ... }` or async variant.
- TypeScript is executed by Pi via a runtime loader; separate build is usually unnecessary.
- Tools describe parameters with schemas, usually via `typebox` `Type.Object(...)`.
- Tool execution must return `content/details` in the Pi tool result format.
- Event handlers may return control objects: `block`/`cancel`/`modified result`/`context`/etc. Before changing event flow, check the current API in docs or existing code.
- Extensions have full system access; any commands, file operations, and network integrations require care.

Official docs when needed: <https://pi.dev/docs/latest>. Most useful sections: `Extensions`, `Pi Packages`, `Session format`, `TUI components`.

Internal quick references:
- `docs/pi-local-map.md` — where to find types and shipped docs inside the local `pi-coding-agent` package.
- `docs/pi-quickref.md` — condensed API reference (events, ExtensionAPI, ExtensionContext, UI primitives, TypeBox patterns).
- `docs/creating-extensions.md` — step-by-step guide for new packages in this collection.
- `docs/patterns.md` — copy-paste snippets for tools, commands, TUI, blocking, state persistence.

## How to work with context

- Do not read everything. This repo has many small independent packages.
- Find the relevant package/symbol first with `rg`.
- Read `README.md`, `package.json`, and specific `.ts` files for that package only.
- For large files, read fragments around the found locations.
- Do not pull in `node_modules` or lock files unless the task is about them.

## Edit rules

- Make targeted changes within the task scope.
- Keep the style of the specific file: ESM, naming, error format, UI messages.
- Keep it minimal: a clear small module and short description beats a universal framework inside an extension.
- Do not do broad cleanup, mass formatting, file renames, or architectural rewrites without a request.
- Do not change dependencies, lock files, or package metadata without explicit permission.
- Do not edit generated/vendor-like data unless that is the task itself.

## README and documentation

Do not update READMEs mechanically after every edit. Use judgment:

- If an extension is still experimental and the task is about code — do not turn the README into mandatory noise.
- If an extension is ready, or a command/tool/install flow/public behavior was added or changed — update that extension's README even if the user did not explicitly ask.
- If a ready extension was added, removed, renamed, or substantially changed in purpose — update the root `README.md` catalog.
- If the change is internal and the user-facing interface did not change — usually skip the README.
- If unsure, briefly mention in the final response: `Consider updating the README after the behavior stabilizes.`
