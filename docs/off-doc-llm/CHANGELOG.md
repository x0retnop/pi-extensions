# Pi Changelog (0.80+ — LLM-adapted)

Curated, extension-relevant summary of Pi releases from 0.80.0. **Not a full changelog** — only what can affect extensions, tooling, or this collection's runtime behavior. Full source: `https://pi.dev/changelog` or GitHub releases (`https://github.com/earendil-works/pi/releases`; raw changelog used by `scripts/check-pi-sync.py`).

Maintained via the `docs/pi-version-sync.md` workflow. Not part of the stable bundled-docs snapshot (`INDEX.md`); update it when a release above the collection baseline is analyzed.

## Version map (0.80.0 → 1.0.1)

| Version | Date | One-liner | Extension impact |
|---|---|---|---|
| 1.0.1 | 2026-10-03 | MCP project overrides/CIMD; `registerToolRenderer()` for tools not registered yet (MCP tools in resumed sessions); Cloudflare Clef classifiers; `npm-shrinkwrap.json` dropped from the package | Low — additive. `registerToolRenderer` is the only new surface the collection might use |
| 1.0.0 | 2026-10-01 | **Fullscreen by default** (`tuiMode: "regular"` to opt out); codemode leaner + image generation; MCP OAuth hardening; `quietStartup: "header"`; Radius in `/login` | Low — host was already fullscreen |
| 0.99.2 | 2026-09-30 | MCP servers stop blocking the first prompt; more MCP auth options; Anthropic workload identity federation; `/reload` picks up tools added to `defaultTools` | None if MCP is unused |
| 0.99.1 | 2026-09-30 | GPT-6.1 Sol (default OpenAI Codex model) | Catalog only |
| 0.99.0 | 2026-09-29 | **Codemode + MCP** (JS scripts calling tools in parallel); system theme from the terminal palette; ChatGPT sign-in; **virtual models** (route a request to another physical model); classifier models; **`fullscreenWheelScrollLines` setting**; `ProviderModelConfig` becomes a `chat \| image \| classifier` union | Medium — type union break for provider metadata; P-1 retires into the setting |
| 0.87.1 | 2026-09-22 | Claude Opus 5.5 / GPT-6 Sol / GPT-6 Luna; **Grok 4.7 shipped built-in and made the xAI default** | Catalog — the host `models.json` `xai` entry adding `grok-4.7` becomes redundant |
| 0.87.0 | 2026-09-21 | Canonical session context + `ContextEditEntry`; `context_with_system` per-request system-message transforms; per-model image input limits | **Breaking** for exhaustive `SessionEntry` switches, `TurnEndEvent` consumers, `agent_settled` handlers |
| 0.86.1 | 2026-09-20 | Meta Muse provider (`/login meta`) | None |
| 0.86.0 | 2026-09-19 | **Prompt cache warming** (cost-aware refreshes during long tool runs); transcript-aware prompt/tool updates (keeps the cached prefix across resume/branch); per-model compaction budgets; `/bug`; offline Radius catalog | Medium for custom providers (pi-ai stream inputs `Context` → `TranscriptContext`); `user_bash` now fails closed |
| 0.85.1 | 2026-09-05 | GPT-6 Astra | Catalog only |
| 0.85.0 | 2026-09-04 | **Normalized mouse pipeline** (`Component.handleMouse`, `TuiMouseEvent`, synthesized `click`) **and click-to-caret in the editor**; fullscreen transcript controls; restorable in-memory sessions (SDK) | High value / low risk — this is the upstream mouse caret the host wanted; drag still selects, so no extension change needed |
| 0.84.4 | 2026-08-27 | `fullscreenCopyOnSelect`; `ui_prompt_start`/`ui_prompt_end`; terminal capability overrides; mid-turn compaction; `triggerTurn:false` no longer splits tool call/result | Low — P-5 still required (host unbound Ctrl+X); optional later for ui-theme Working |
| 0.84.3 | 2026-08-24 | **CLI loads esbuild bundle**; optional `powershell` tool; `/thinking` + session-scoped `/model`; Windows keybinding defaults; Grok 4.6 → Responses + xAI default; Kimi `cached_tokens` as cache read; lazy jiti | **High for patches** — P-1…P-5 must target `dist/bundle/chunks/`; do not enable `powershell` |
| 0.84.2 | 2026-08-18 | nanoid security; Kimi built-in masquerade removed (`mergeClientHeaders` forces `pi (win32 …; x64)` on `kimi-coding`); `defaultTools` no longer drops extension tools; fullscreen search | Medium — re-apply P-1…P-5; custom `kimi-main` / `kimi-main-ant` UA untouched |
| 0.84.1 | 2026-08 | fullscreen TUI; `tool_call` result `terminate`; `AGENTS.override.md`; `registerMarkdownTransformer`; `--use-theme`; `scrollbarThumb` | Low after adoption — P-1 (wheel step 3) needed on fullscreen |
| 0.83.0 | 2026-07-29 | TypeBox 1.3.7 (deprecated APIs removed), `ctx.scopedModels`, `user_bash` RPC bypass fix, `"pending"` stop reason | Low — no local TypeBox imports; no `user_bash` handlers |
| 0.82.1 | 2026-07-25 | `outputPad` exposed to renderers; compaction/branch auth fixes | None |
| 0.82.0 | 2026-07-24 | Bash tools get session env vars (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`); streaming RPC `bash_execution_update`; `supportsGrammarTools`/`supportsStrictTools` | None (additive) |
| 0.81.1 | 2026-07-21 | Compaction/branch retry policy; **restored pre-0.81 agent-core stream fallback** | None (compat restored) |
| 0.81.0 | 2026-07-21 | Full provider extensions (native auth/refresh/filter/stream); tool+compaction usage accounting; exported lifecycle event types | None (additive) |
| 0.80.10 | 2026-07-16 | Minor fixes | None |
| 0.80.9 | 2026-07-16 | Kimi K3 across built-in providers; deferred tool loading | None (additive) |
| 0.80.8 | 2026-07-16 | **ModelRuntime refactor: `ModelRegistry.authStorage` REMOVED, `refresh()` → async, SDK options → `modelRuntime`, `pi update --models`** | **Breaking** — model-manager fixed 2026-08-01 (see below) |
| 0.80.7 | 2026-07-14 | `compat.sendSessionIdHeader` → `sessionAffinityFormat`; cache-friendly dynamic tool loading; `Ctrl+X` copy | Breaking (models.json only) |
| 0.80.6 | 2026-07-09 | `max` thinking level; input-token pricing tiers | None |
| 0.80.5/0.80.4 | 2026-07-09 | Cache-miss notices; `agent_settled`, `before_provider_headers`, entry renderers, `InlineExtension`; project-local `pi config -l` | Additive |
| 0.80.3 | 2026-06-30 | Claude Sonnet 5; `outputPad`; RPC `get_entries`/`get_tree`; `session_info_changed` event | Additive |
| 0.80.2 | 2026-06-23 | `ApiKeyCredential` discriminator `"api_key"`; `ExecutionEnvExecOptions` → `ShellExecOptions` | Low |
| 0.80.1 | 2026-06-23 | Provider-only fixes | None |
| 0.80.0 | 2026-06-23 | pi-ai global API (`getProviders`/`getModels`/`stream`/`complete`/…) moved to `@earendil-works/pi-ai/compat`; runtime loader aliases root → compat | Typecheck-only (collection already on `/compat`) |

## Breaking changes since 0.80.0 (extension-facing)

| Change | Version | Impact | Fix |
|---|---|---|---|
| `ctx.modelRegistry.authStorage` removed | 0.80.8 | Runtime `undefined.get()` crash + typecheck error | `await ctx.modelRegistry.getApiKeyForProvider(id)` (fallback to env var) or `getProviderAuth(id)` |
| `ModelRegistry.refresh()` `void` → `Promise<void>` | 0.80.8 | Un-awaited calls race sync registry reads | `await` before reading |
| SDK `CreateAgentSessionOptions.authStorage`/`modelRegistry` → `modelRuntime` | 0.80.8 | SDK-level only; extension `ModelRegistry` facade preserved | Only SDK consumers affected |
| `compat.sendSessionIdHeader` → `compat.sessionAffinityFormat` | 0.80.7 | `models.json` configs | `"openai"` / `"openai-nosession"` / `"openrouter"` |
| pi-ai root API → `/compat` | 0.80.0 | Runtime OK via loader alias; typecheck breaks | Import from `@earendil-works/pi-ai/compat` |
| TypeBox 1.3.7: `Type.Base`, `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`, `Type.Options`, `Value.Mutate` removed | 0.83.0 | Only if extension imports `@sinclair/typebox` directly | Migrate to 1.3.7 API |
| `message_update` no longer carries cumulative `message` + `partial` | 0.84.1 | JSON/RPC transports only; extension event bus still passes both | Do not treat as an extension-bus break |
| Built-in `kimi-coding` UA forced to `pi (win32 …)` | 0.84.2 | User UA overrides on that provider id are stripped | Custom provider id (kimi-main pattern) if a different UA is required |
| CLI/RPC entrypoints load esbuild bundle | 0.84.3 | Modular `dist/` patches no longer affect running `pi` | Patch `dist/bundle/chunks/` (see `docs/runtime-patches.md`) |
| `GoogleThinkingLevel` → `GoogleApiThinkingLevel` | 0.84.3 | pi-ai internal; no local matches | None |
| pi-ai provider stream inputs `Context` → `TranscriptContext`; `ToolCall.arguments` / `ToolResultMessage.details` restricted to JSON | 0.86.0 | Custom providers only; built-in providers unaffected | Rewrite only if the repo defines a provider stream |
| `user_bash` fails closed on error/invalid result | 0.86.0 | Handlers that returned ignored values now abort the command | Return a valid result or `undefined` explicitly |
| `shouldStopAfterTurn` removed; `ContextEditEntry` added to the `SessionEntry` union; `TurnEndEvent` gained required boundary fields; `agent_settled` runs are deferred until all handlers finish | 0.87.0 | `turn_end` / `agent_settled` handlers in `a-rewind`, `payload-trace`, `ui-theme` (all read events loosely, so `tsc` stays clean) | Audit those three handlers when their behavior matters; exhaustive entry switches need a `context_edit` case |
| `ProviderModelConfig` split into `chat \| image \| classifier` | 0.99.0 | Any code reading `reasoning`/`contextWindow`/`maxTokens` off the union | Narrow with `Extract<ProviderModelConfig, { reasoning: boolean }>` (see `infer-local/gateway.ts`) |
| `Theme["fgColors"]` made private | 1.0.1 | Code deriving colour names from the theme record | Use `Parameters<Theme["fg"]>[0]` (see `pi-agent-run/highlighter.ts`) |

## Additive APIs worth knowing (0.80.0+)

- `pi.appendEntry` + `pi.registerEntryRenderer` — display-only persisted entries (used by `ui-theme` turn log).
- `agent_settled` event; `before_provider_headers` hook; `session_info_changed` event.
- `ctx.scopedModels` (0.83.0) — session's resolved model scope.
- `outputPad` setting, exposed to custom message renderers (0.82.1).
- Bash session env vars `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` (0.82.0) — useful for `pi-agent-run`/`sub-agents`.
- Full provider registration (`registerProvider` with native auth/model refresh/streaming) (0.81.0).
- Kimi K3 + deferred/dynamic tool loading (0.80.9 / 0.80.7).
- `pi update --models` — force model catalog refresh without updating pi (0.80.8).
- `tool_call` result `terminate` (0.84.1) — simple-gate can stop an all-terminating batch without a follow-up model call.
- `registerMarkdownTransformer` (0.84.1) — model-manager `/grok-think` display collapse.
- `expandPromptTemplates` on `pi.sendUserMessage()` (0.84.2) — context-guard does not pass it; default unchanged.
- Fullscreen search `Ctrl+Shift+F`, `--use-theme` (0.84.2).
- `session_compact_failed` event; `ui_prompt_start` / `ui_prompt_end` (0.84.3 / 0.84.4).
- `fullscreenCopyOnSelect` (0.84.4) — partial P-5; not sufficient on this host.
- Optional built-in `powershell` tool (0.84.3) — **do not enable**; host uses `pi-agent-run` `pwsh`.
- Editor mouse caret + normalized `Component.handleMouse` events (0.85.0) — the reason no host P-9 exists; press/drag/release stay unhandled so screen-level selection keeps working.
- Prompt cache warming (0.86.0) + transcript-aware prompt/tool updates (0.86.0) — the cache-friendly replacements for what the host used to patch around; `cache_warming_decision` event lets an extension override the decision.
- `context_with_system` (0.87.0) and `ContextEditEntry` (0.87.0) — per-request system-message transforms and history-free context edits.
- Virtual models (0.99.0) — an extension can resolve a request to a different physical model.
- `fullscreenWheelScrollLines` (0.99.0) — retires runtime patch P-1.
- `pi.registerToolRenderer()` (1.0.1) — render tool calls that are not registered yet (MCP tools in resumed sessions).
- MCP servers, codemode, classifier and image models (0.99.0+) — all inert unless configured; the host does not use them.

## Collection status (as of 2026-10-03)

- Installed / documented baseline: **1.0.1** (see `docs/pi-version-sync.md` upgrade log).
- 1.0.1 upgrade: `tsc` clean after two type fixes (`infer-local` row union, `pi-agent-run` theme tokens); `pi-agent-run` added to the `tsconfig.json` include (it was silently outside the gate); 588/588 unit tests; extension tree deployed unchanged (type-only edits emit identical JS); `18 extensions, 0 errors` in `ext_load_bench`; end-to-end provider request verified on a throwaway agent dir.
- Runtime patches: **P-1 retired** into `fullscreenWheelScrollLines: 3`, **P-5 site 1** into `fullscreenCopyOnSelect: false`; P-2/P-3/P-4/P-6/P-7 re-applied, **P-8 moved to `dist/bundle/cli-runtime.js`** — `docs/runtime-patches.md`.
- Built-in `grok-4.7` is shipped and default on 1.0.1 — the host `models.json` `xai` entry that adds it is redundant (config cleanup, not a breakage). See `docs/pi-provider-payloads.md` §1b.
- Kimi UA: honest `pi (win32 …)` via `mergeClientHeaders` (verified in the 1.0.1 bundle); no `User-Agent` in `models.json`.
- Host `models.json` providers as of 2026-10-03: `kimi-main-ant`, `ollama-cloud`, `kimi-coding` (overrides) — the `xai` entry that added `grok-4.7` by hand was removed once 1.0.1 shipped it built-in. P-6 keeps `xai`, `opencode`, `opencode-go`, `kimi-coding` and (since 2026-10-04, by choice) `openrouter` catalogs and blanks the other 37.
- Verified unaffected: TypeBox (`Type.Object`/`String` only), `renderShell: "self"`, `user_bash` (none), `@mariozechner` (none), `reasoningEffortMap` (none), root pi-ai imports (`/compat`), all 35 host `keybindings.json` ids (present in 1.0.1), `defaultTools` (still no built-in `powershell`).
- Off-doc snapshot refreshed 2026-10-03: added `HOW-PI-WORKS`, `CLI`, `SLASH-COMMANDS`, `MESSAGE-TYPES`, `CONFIGURATION`, `ENVIRONMENT-VARIABLES`, `VIRTUAL-MODELS`, `SHELL-ALIASES`. `DEVELOPMENT` lost its upstream page in 1.0.1 (kept). Still unadapted by choice (inert or other platforms): `mcp`, `codemode`, `rpc-commands`, `rpc-extension-ui`, `llama-cpp`, `terminal-setup`, `tmux`, `termux`, `index` — see `INDEX.md`.
