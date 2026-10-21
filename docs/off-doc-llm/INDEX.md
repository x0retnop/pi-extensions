# Pi Docs — LLM-Optimized

Adapted from `@earendil-works/pi-coding-agent` bundled docs.
Minimal prose, maximum tables, types, and signatures.
Snapshot of bundled docs. After a Pi CLI upgrade, if this disagrees with live behavior, the installed package wins — then refresh the off-doc. Curated extension-relevant changelog: `CHANGELOG.md` (via `docs/pi-version-sync.md`).

## File map

| File | Original(s) | Content |
|------|-------------|---------|
| `TYPES.md` | — | **All key types** compact: events, tools, ExtensionAPI, Context, Session |
| `HOW-PI-WORKS.md` | how-pi-works.md | Loop, context, sessions, interfaces, resources, trust |
| `QUICKSTART.md` | quickstart.md | Install, authenticate, first run |
| `CLI.md` | cli.md + cli-integration.md | All flags and subcommands, then integration (modes, print/JSON/RPC, fork/rebrand) |
| `SLASH-COMMANDS.md` | slash-commands.md | Built-in slash commands |
| `USAGE.md` | usage.md | Interactive mode, slash commands, editor features |
| `SESSIONS.md` | sessions.md + session-format.md | Sessions, CLI flags, JSONL format, SessionManager API |
| `MESSAGE-TYPES.md` | message-types.md | Content blocks, `Usage`, base and coding-agent messages, `AgentMessage` union |
| `CONFIGURATION.md` | configuration.md | Agent dir, project `.pi`, context files |
| `COMPACTION.md` | compaction.md | Compaction and branch summarization |
| `SETTINGS.md` | settings.md | All settings: tables, types, defaults |
| `ENVIRONMENT-VARIABLES.md` | environment-variables.md | Process markers, shell-tool session env (`PI_SESSION_ID` …), Pi process config |
| `PROVIDERS.md` | providers.md + custom-provider.md + models.md | Providers, API keys, custom providers, models config |
| `VIRTUAL-MODELS.md` | virtual-models.md | `registerVirtualModel`, `route()`, router state |
| `EXTENSIONS.md` | extensions.md | **Main file**: events, API, tools, UI, commands |
| `SKILLS.md` | skills.md | Skill format, locations, commands |
| `PROMPT-TEMPLATES.md` | prompt-templates.md | Prompt template format |
| `THEMES.md` | themes.md | Theme JSON format, color tokens |
| `PACKAGES.md` | packages.md | Pi packages: install, create, sources |
| `TUI.md` | tui.md | TUI components, Component/Focusable interfaces |
| `SDK.md` | sdk.md | SDK: createAgentSession, AgentSession API |
| `RPC.md` | rpc.md + json.md | RPC protocol, JSON Event Stream |
| `SECURITY.md` | security.md | Security model, project trust |
| `CONTAINERIZATION.md` | containerization.md | Container patterns: Gondolin, Docker, OpenShell |
| `KEYBINDINGS.md` | keybindings.md | All keybindings table |
| `SHELL-ALIASES.md` | shell-aliases.md | Shell resolution, `shellPath`, `shellCommandPrefix`, aliases |
| `WINDOWS.md` | windows.md | Windows-specific setup |
| `DEVELOPMENT.md` | development.md (page removed upstream in 1.0.1 — trimmed to what applies here) | Debug-log paths (`/debug`, `PI_TUI_DEBUG*`), fork/rebrand keys |
| `CHANGELOG.md` | — (curated from pi.dev/changelog) | **Extension-relevant changelog 0.80+**; maintained via `docs/pi-version-sync.md` workflow |

## How to read

1. **`TYPES.md`** — looking for a type or method signature
2. **`EXTENSIONS.md`** — most important and largest; read by sections
3. **Other files** — on demand when the task touches the area

## Not adapted (read them in the installed package)

Shipped pages with no off-doc twin — `…/pi-coding-agent/docs/<name>.md`:

| Page | Why skipped |
|---|---|
| `mcp.md` | MCP servers — inert here (none configured) |
| `codemode.md` | codemode subsystem — inert here |
| `rpc-commands.md`, `rpc-extension-ui.md` | RPC mode — not used here |
| `llama-cpp.md` | llama.cpp backend — this host uses the `infer-local` gateway instead |
| `terminal-setup.md`, `tmux.md`, `termux.md` | Terminal/platform setup — Windows Terminal host, see `WINDOWS.md` |
| `index.md` | Docs landing page — this file replaces it |

Host verdict for each (off subsystem / RPC path / other platform): `docs/pi-features.md`.

## Adaptation rules

- Tables over lists
- TypeScript types over prose descriptions
- Method signatures with brief semantics
- Code examples only where the API is non-trivial
- Section names are normalized for `read mode:section`
