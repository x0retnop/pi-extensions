# Pi Coding Agent — Local Package Map

Quick navigation for agents working with the installed `@earendil-works/pi-coding-agent` package.

## Install location

`C:\Users\user\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent`

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
| `docs/development.md` | Local dev setup, debugging, extension auto-reload. |
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
