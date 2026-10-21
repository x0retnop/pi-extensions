# Pi Coding Agent — Local Package Map

Quick navigation for agents working with the installed `@earendil-works/pi-coding-agent` package. **Prefer `docs/off-doc-llm/` first.** This file is the path index when the off-doc is silent.

## Install location

`C:\Users\user\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent`

Live CLI (1.0.1) is `dist/bundle/cli.js` — a shim that calls `enableCompileCache()` and requires
`dist/bundle/cli-runtime.js`, which statically imports 15 eager chunks. Modular `dist/*.js` is the
library/`tsc` mirror — not what `pi` executes, but complete and runnable (`node dist/cli.js --version`,
~1.0 s versus 0.24 s for the bundle; unchanged with a warm jiti/compile cache). Runtime patches:
`docs/runtime-patches.md`.

## Bundle layout: what loads at startup

`cli-runtime.js` statically imports **15 chunks = ~3.59 MB parsed + evaluated on every start**
(measured 2026-10-03, after P-6; 15 MB of chunks total); everything else is reached by `import()` later.

| chunk | size | when | what |
|---|---|---|---|
| `chunk-5OEJBNHG.js` | 2624 KB | **eager** | core + system prompt + built-in tools + MCP/codemode plumbing + the model catalog of all 42 built-in providers (730 KB of top-level data, blanked for unused providers by P-6; 3353 KB stock) + undici's llhttp wasm (~140 KB base64) |
| `chunk-6FX7UEPL.js` | 472 KB | **eager** | the whole TUI inlined, incl. `TuiAltScreen` (P-5, P-7 live here), config (`APP_NAME`, `APP_TITLE`), keybindings |
| `chunk-SYF2TF6W.js` | 211 KB | **eager** | mode/session machinery (codemode + MCP references) |
| `chunk-S3GGRYIO.js` | 109 KB | **eager** | highlight.js core + languages |
| `chunk-PDFMCAOZ.js` | 103 KB | **eager** | MCP client/tool wiring |
| 10 small chunks | 0–34 KB | **eager** | event-stream, partial-json, armin/easter-egg helpers, bun-env |
| `lib-*.js` | ~950 KB | lazy | the rest of highlight.js — `loadAllHighlightLanguages()` fires right after first paint, so it lands in every session anyway |
| `chunk-3LH3ZQKY.js` | ~927 KB | lazy | image/export tooling (photon wasm wrapper and friends) |
| provider SDKs (`anthropic-messages-*`, `bedrock-converse-stream`, `openai-*`, `xai`, `kimi-coding`, …) | 7–880 KB | lazy | one file per provider API — imported on the first request to that provider |
| `codemode-worker.js`, `execute-*.js`, `llama-cpp-classify-*.js` | 35–71 KB | lazy | codemode sandbox, classifier runtimes — never touched when codemode is not enabled |
| `@silvia-odwyer/photon-node` | 1.8 MB wasm | lazy | image resize; never loaded with `images.autoResize: false` |

Consequences: the only cut that pays off is the provider catalog (P-6, `scripts/pi_runtime_decat.py`),
because it is top-level data in the eager chunk; unused subsystems (MCP, codemode, classifiers) keep
only their config plumbing eager and their workers lazy, so removing them buys nothing measurable — the
real runtime cost is elsewhere (see `docs/ext-load-perf.md`). Mechanically, the 1.0.x split helps
maintainers: a TUI patch is one 472 KB chunk with `TuiAltScreen=class` in it, not a 3.6 MB haystack.

The dev repo's `node_modules/@earendil-works/{pi-coding-agent,pi-ai,pi-tui}` are directory junctions to this install (and its nested `pi-ai` / `pi-tui`). Do not npm-install those packages into the repo — `docs/pi-workflow.md`.

## Directory layout

```text
pi-coding-agent/
  CHANGELOG.md          # Release notes
  README.md             # Package readme
  package.json          # Package metadata
  dist/                 # Compiled JS + .d.ts types (runtime source)
  docs/                 # Markdown docs shipped with the package
  examples/             # Extension examples (rpc-extension-ui.ts, README.md)
  node_modules/         # Own dependencies (typebox, pi-ai, pi-tui, etc.)
```

## Key files in `dist/`

| File | What it exports |
|---|---|
| `dist/index.d.ts` | Main public API: `ExtensionAPI`, `ExtensionContext`, `ToolDefinition`, `Theme`, `SessionManager`, `main()`, `runPrintMode`, components, etc. Start here. |
| `dist/core/extensions/types.d.ts` | **Extension system types**: all event types, `ExtensionAPI` methods, `ExtensionContext`/`ExtensionCommandContext`, `ToolDefinition`, handler signatures, event results (`block`, `cancel`, `message`, etc.). |
| `dist/core/extensions/index.d.ts` | Re-exports from `types.d.ts` plus runtime helpers (`createExtensionRuntime`, `defineTool`, `wrapRegisteredTool`, `ExtensionRunner`). |
| `dist/core/tools/index.d.ts` | Built-in tool input/output types: `BashToolInput`, `ReadToolInput`, `WriteToolInput`, `EditToolInput`, `GrepToolInput`, `FindToolInput`, `LsToolInput`, and their `*Details` result types. |
| `dist/core/tools/truncate.js` | `DEFAULT_MAX_LINES` (2000), `DEFAULT_MAX_BYTES` (50KB), `truncateHead`, `truncateTail`. Hard limits and truncation logic for built-in tool outputs. |
| `dist/providers/data/<provider>.json` (in `pi-ai`) | Shipped per-provider model catalog (`contextWindow`, `maxTokens`, `input`, `cost`, `compat`, `thinkingLevelMap`). Gaps here are why a new model shows invented values — `docs/pi-providers-models.md` "Catalog gaps". |
| `dist/core/tools/read.js` | `createReadTool`, `createReadToolDefinition`. Image resizing, auto-resize logic, truncation notices with `offset` continuation, and the actual built-in read implementation. |
| `dist/modes/interactive/theme/theme.d.ts` | `Theme`, `ThemeColor`, `initTheme`, `getLanguageFromPath`, `highlightCode`. |
| `dist/core/session-manager.d.ts` | `SessionManager`, `SessionEntry`, `SessionMessageEntry`, `CompactionEntry`, `BranchSummaryEntry`, etc. |
| `dist/core/sdk.d.ts` | SDK factory functions: `createAgentSession`, `createCodingTools`, `createBashTool`, `createReadTool`, etc. |
| `dist/modes/interactive/components/index.d.ts` | TUI components: `ToolExecutionComponent`, `AssistantMessageComponent`, `FooterComponent`, `CustomEditor`, etc. |
| `dist/core/event-bus.d.ts` | `EventBus`, `createEventBus` for inter-extension comms. |
| `dist/core/compaction/index.d.ts` | Compaction helpers and types. |
| `dist/core/settings-manager.d.ts` | `SettingsManager`, `PackageSource`, `ImageSettings`. |
| `dist/core/skills.d.ts` | `Skill`, `loadSkills`, `formatSkillsForPrompt`. |
| `dist/utils/clipboard.d.ts` | `copyToClipboard`. |
| `dist/utils/frontmatter.d.ts` | `parseFrontmatter`, `stripFrontmatter`. |
| `dist/utils/shell.d.ts` | `getShellConfig`. |

## Docs shipped in `docs/`

These are the same pages published on https://pi.dev/docs/latest.

| File | Topic |
|---|---|
| `docs/extensions.md` | Extension lifecycle, events, tools, commands, custom UI. |
| `docs/packages.md` | Pi package structure, install sources, dependencies, filtering. |
| `docs/session-format.md` | Session JSONL format, entry types, `SessionManager` API. |
| `docs/tui.md` | TUI components, custom overlays, keyboard handling. |
| `docs/skills.md` | Skill format, loading, frontmatter. |
| `docs/themes.md` | Theme JSON format and customization. |
| `docs/settings.md` | Global and project settings. |
| `docs/compaction.md` | Context compaction and branch summarization. |
| `docs/providers.md` | Provider config and custom provider setup. |
| `docs/models.md` | Custom model entries. |
| `docs/usage.md` | Interactive mode, slash commands, context files. |
| `docs/quickstart.md` | First-run guide. |
| `docs/json.md` | JSON event stream mode. |
| `docs/rpc.md` | RPC mode over stdin/stdout JSONL. |
| `docs/sdk.md` | Embedding Pi in Node.js apps. |
| `docs/windows.md` | Windows-specific notes. |

## How to use this map

- **Adding a new tool** → read `dist/core/extensions/types.d.ts` for `ToolDefinition` shape.
- **Intercepting events** → same file: search for `ExtensionEvent`, `ToolCallEventResult`, `SessionBeforeCompactResult`, etc.
- **Custom TUI** → `dist/core/extensions/types.d.ts` (`ExtensionUIContext.custom`) + `dist/modes/interactive/components/index.d.ts` + `docs/tui.md`.
- **Session state** → `dist/core/session-manager.d.ts` + `docs/session-format.md`.
- **Package/install rules** → `docs/packages.md`.
