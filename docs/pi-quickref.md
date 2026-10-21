# Pi Extension API — map

Four surfaces in this repo cover "how to write an extension". This file only **routes** between them
and states who owns what — it deliberately keeps no API copy, so the facts cannot drift.

| You need | Owner |
|---|---|
| The API itself: lifecycle order, the event table, `pi.*` methods, `ctx`, custom tools, state, rendering, mode behavior | `docs/off-doc-llm/EXTENSIONS.md` |
| An exact type or signature (`ExtensionContext`, `ExtensionAPI`, `ToolDefinition`, event payloads, `Theme`, `SessionManager`, …) | `docs/off-doc-llm/TYPES.md` |
| To add an extension to **this repo**: package shape, naming, `package.json`, `index.ts` scaffold, build + deploy, style rules | `docs/creating-extensions.md` |
| A copy-paste snippet for a specific job (block a call, mutate args, persist state, footer status, cross-extension events) | `docs/patterns.md` |
| Tool rendering (`renderShell` / `renderCall` / `renderResult`) | `docs/tool-rendering.md` |
| A hard-won pitfall to avoid | `docs/pi-extension-gotchas.md`, `docs/burned.md` |

## Peer dependencies in this collection

`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` and `typebox` go
in `peerDependencies` with `"*"` (never bundled); everything else goes in `dependencies`.
Rules and rationale: `docs/pi-workflow.md` §"How dependencies work".
