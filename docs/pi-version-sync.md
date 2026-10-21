# Pi Version Sync — Agent Guide

How to check if extensions need updates after a Pi CLI release, without burning tokens.

For Pi version questions, run `scripts/check-pi-sync.py` first, then read this doc. Do not browse the web before the script.

Baseline: **1.0.1** — collection tested and working with this version. Do not analyze versions at or below this.

## When to run this

Only when the user explicitly says Pi was updated, or asks whether to upgrade.

## Why both a script and a web check?

The script is a **fast local linter** (≤ 2 s): it finds version delta and obsolete code patterns in local extensions automatically. The web check is a **judgement layer**: it reads the CHANGELOG to decide whether those deltas actually matter. They complement each other — don't drop the script just because the agent can browse the web.

## Core rule

Do **not** analyze versions at or below the **baseline** (see above). They are already validated.  
Only look at releases **newer** than the baseline.

## Workflow

### 1. Automated delta check

Run `python scripts/check-pi-sync.py` from the repository root. It detects the **globally installed** Pi version and prints:
- Newer releases above the installed version.
- Known obsolete patterns found in local extensions.

Use this output as the starting point.

### 2. Is the upgrade worth it? (Agent assessment)

Read the CHANGELOG delta **above baseline** at **`https://pi.dev/changelog`**. Use the version entry summaries (and the linked full release notes if needed) to assess red flags. Give the user a one-line verdict per flagged area:

| Verdict | When to say it |
|---|---|
| **Worth upgrading** | There is a security fix, a needed ExtensionAPI addition, a bug that affects this collection, or a feature the user explicitly asked for. |
| **Can skip** | The delta is only provider-specific fixes (Bedrock, Anthropic, Azure...), TUI polish, model metadata tweaks, or unrelated built-in provider changes. |
| **Neutral / review needed** | Breaking Changes touch ExtensionAPI, events, tool rendering, runtime, or package scopes. Extensions *may* need fixes — present the trade-off and let the user decide. |

Be honest and brief. Do not push an upgrade just because a newer version exists.

### 3. If the user says "do not upgrade"

Stop. Do not touch extension code. Do not update this document.

### 4. If the user says "upgrade" or there are Breaking Changes

Proceed in this order:

1. **Map red flags to files** — `rg` the affected API keywords in `*/index.ts`, `*/src/**/*.ts`, and `*/package.json`.
2. **Fix obsolete patterns** — see the table below.
3. **Type-check** — run `npx tsc --noEmit` from the repository root.
4. **Deploy** — `pwsh -File ./sync-extensions.ps1` (compiles `_build/extensions` and mirrors it into
   `~/.pi/agent/extensions/`, removing stale `.ts`/`package.json`), then restart Pi.
5. **Smoke-test** — run one command or tool from each affected extension to confirm it still works.

### 5. After successful test

Only now update documentation:

1. Bump the baseline version at the top of this file to the new Pi version.
2. If you discovered a new obsolete pattern or red flag, add it to the tables below.
3. Update an extension's folder `README.md` only if its public behavior or install flow changed.
4. Update `docs/extensions/INDEX.md` if an extension was added, removed, or changed in purpose.

## Red flags

Look for these keywords in CHANGELOG headings and bullets above the baseline:

| Red flag | Why it matters | Real example |
|---|---|---|
| **Breaking Changes** | Always check extensions using the affected API. | `0.75.0` raised minimum Node to `22.19.0`. `0.72.0` replaced `compat.reasoningEffortMap` with `thinkingLevelMap`. |
| **Extension API** / `registerProvider` | Provider/model metadata shape may change. | `0.72.0` added per-model `baseUrl`; `0.71.0` added `name` to `registerProvider`. |
| **Events** renamed / added / removed | Event handlers may break or need updates. | `0.71.0` added `thinking_level_select`; `message_end` can now replace finalized messages. |
| **Tool rendering / streaming** | Extensions overriding built-in tools may break. | `0.73.0` incremental bash streaming changed how `bash` output arrives. |
| **UI / TUI / theme** | Custom components or status widgets may break. | `0.74.1` fixed theme sharing across scopes; `0.75.1` config selectors scale to terminal height. |
| **Runtime / loader** | Extension loading mechanism changes. | `0.73.1` switched to upstream `jiti` 2.7. |
| **Package scope rename** | Old imports fail hard. | `0.74.0` moved from `@mariozechner/*` to `@earendil-works/*`. |

## Obsolete patterns

These always mean an extension needs fixing:

- Imports from `@mariozechner/pi-coding-agent` or `@mariozechner/pi-tui` → must be `@earendil-works/*`.
- `compat.reasoningEffortMap` in provider definitions → must be `thinkingLevelMap`.
- A tool override that relies on the built-in renderer merge → re-verify after a tool-rendering change: the merge (`withBuiltInRenderers`) must still fill **only** the `renderCall`/`renderResult` an override omits, which is what keeps read-mode / grep-tool / context-guard correct; a changed merge shows up as duplicate blocks or a raw-args dump (see `tool-rendering.md` §"How a tool row is built").
- Imports of pi-ai's old global API (`getProviders`, `getModels`, `stream`, `complete`, ...) from the package root → moved to `@earendil-works/pi-ai/compat` in 0.80.0 (runtime loader aliases root → compat, so only typecheck breaks).
- `compat.sendSessionIdHeader` in `models.json` → removed in 0.80.7, use `compat.sessionAffinityFormat` (`"openai"` / `"openai-nosession"` / `"openrouter"`).
- `ctx.modelRegistry.authStorage` in extension code → removed from the extension-facing `ModelRegistry` in 0.80.8, use `await ctx.modelRegistry.getApiKeyForProvider(id)` (fallback to env var) or `getProviderAuth(id)`.
- `Theme["fgColors"]` → the record went private in 1.0.1; derive the token type instead: `Parameters<Theme["fg"]>[0]`, optionally narrowed with `Extract<…, "syntax…">` (see `pi-agent-run/highlighter.ts`).
- Reading chat-model fields (`reasoning`, `contextWindow`, `maxTokens`, `thinkingLevelMap`) off `ProviderModelConfig` → it is a union of `chat | image | classifier` since 0.99; narrow it (`Extract<ProviderModelConfig, { reasoning: boolean }>`, as in `infer-local/gateway.ts`) instead of casting.
- An extension folder missing from `tsconfig.json` include → `npm run typecheck` silently skips it (only `tsconfig.test.json` may list it). Pi 1.0.1 exposed `pi-agent-run` this way; check the include list when adding an extension.

## Upgrade log

| Upgrade | Notes |
|---|---|
| 0.84.4 → 1.0.1 | Clean for extensions after two type fixes: `ProviderModelConfig` is now a 3-way union (`chat`/`image`/`classifier`), so `infer-local` narrows with `type ChatRow = Extract<ProviderModelConfig, { reasoning: boolean }>`; `Theme["fgColors"]` is gone (private now) — `pi-agent-run/highlighter.ts` derives its token union from `Parameters<Theme["fg"]>[0]`. Also closed a gate gap: `pi-agent-run/**` was missing from `tsconfig.json` include, so `tsc` never saw it (`tsconfig.test.json` did). One stale test fixture (hardcoded `resetsAt` in the opencode-go usage sample) now dated relative to the run. **Bundle layout changed**: `bundle/cli.js` is a shim (`enableCompileCache()` + `require("./cli-runtime.js")`) over **15 eager chunks** — core/prompt/catalog in `chunk-5OEJBNHG.js`, the whole TUI incl. `TuiAltScreen` in `chunk-6FX7UEPL.js`, CLI entry (`setupCli`) in `cli-runtime.js`. **Mouse caret is upstream**: 0.85.0 added the normalized mouse pipeline (`Component.handleMouse`, `TuiMouseEvent`, synthesized `click`) and `Editor.handleMouse` places the caret on a left click while drag still selects — no host P-9 needed. **P-1 retired** into `fullscreenWheelScrollLines: 3`, **P-5 site 1** into `fullscreenCopyOnSelect: false`; P-2/P-3/P-4/P-6/P-7 re-applied, **P-8 moved to `dist/bundle/cli-runtime.js`**. `scripts/pi_runtime_decat.py` now understands the 0.99+ catalog wiring (one groups var feeds the chat/image/classifier flatteners) and blanks 730 KB. All 35 host `keybindings.json` ids still exist; `defaultTools` default unchanged (no built-in `powershell`). `grok-4.7` ships built-in, so the hand-written `xai` entry in `models.json` is now redundant. New heavy subsystems (MCP, codemode, classifiers) are inert unless configured and sit in lazy chunks, except their config plumbing in the eager set. || 0.84.2 → 0.84.4 | Clean for extensions (`tsc` clean, no obsolete patterns). **Live CLI is the esbuild bundle** (`dist/bundle/cli.js` → `chunks/chunk-OMWWHBTG.js`); P-1…P-5 re-applied on the chunk **and** modular mirrors. Did not enable built-in `powershell`. `keybindings.json` untouched (Windows search default becomes `Ctrl+F`). Built-in `grok-4.6` now `openai-responses` (host `models.json` override redundant). Kimi `cached_tokens` = cache read. `fullscreenCopyOnSelect` exists but does not replace P-5 here (`app.message.copy` unbound). |
| 0.84.1 → 0.84.2 | Clean. No ExtensionAPI breaks. `tsc` clean on existing 0.84.1 devDeps (no bump). Kimi masquerade removed intentionally (`mergeClientHeaders` forces `pi (win32 …; x64)` on provider id `kimi-coding`; custom `kimi-main` / `kimi-main-ant` untouched). `defaultTools` is opt-in and no longer drops extension tools. Additive: fullscreen search (`Ctrl+Shift+F`), `--use-theme`, `expandPromptTemplates` on `pi.sendUserMessage()` (context-guard does not pass it — default unchanged). **P-1 + P-2 re-applied** on 0.84.2 stock (P-2 now robustness-only; see `docs/runtime-patches.md`). |
| 0.83.0 → 0.84.1 | Clean. Dev deps: pi-ai + pi-tui bumped 0.83 → 0.84.1 (dual-instance type alignment; standalone copies must match the runtime's nested ones or tsc fails on TUI/RefreshModelsContext identity). `message_update` breaking change (cumulative `message` + `partial` removed) affects only JSON/RPC transports — extension event bus still passes both through. New useful surfaces: `tool_call` result `terminate` (simple-gate can stop all-terminating batches without follow-up model call), `AGENTS.override.md` (context-guard overview lists only AGENTS.md/CLAUDE.md — gap), `scrollbarThumb` theme color (ui-theme presets, fullscreen), fullscreen TUI mode, `pi auth check` CLI, `registerMarkdownTransformer`. **Runtime patch P-1 active** (fullscreen wheel step 3, see `docs/runtime-patches.md`) — re-apply if wiped by this upgrade. |
| 0.80.7 → 0.83.0 | Clean after pre-fix for 0.80.8 `authStorage`. model-manager: `getApiKeyForProvider`, `ctx.scopedModels` (favorite cycle + UI tags + pinned thinking), `ProviderConfig.refreshModels` for curated openrouter/opencode-go, `/mm` Refresh all awaits `modelRegistry.refresh()`. TypeBox 1.3.x — only basic `Type.Object` schemas in extensions. |
| 0.79.10 → 0.80.7 | Clean. `getProviders` import moved to `/compat` (model-manager). New APIs worth knowing: entry renderers (`pi.appendEntry` + `pi.registerEntryRenderer`, display-only, used by `ui-theme` turn log), `agent_settled` event, `before_provider_headers` hook, cache-friendly dynamic tool loading, `showCacheMissNotices` setting. `Current date:` removed from the default system prompt. |

## Decision matrix

| Situation | Action |
|---|---|
| No red flags in CHANGELOG delta | Do nothing. Mention briefly: «Pi update looks safe for this collection.» |
| Red flags but no local matches | Do nothing. No extension uses the affected surface. |
| Red flags + local matches + `tsc` errors | Fix the specific errors. Update the extension doc / folder README if public behavior changed. |
| Red flags + local matches + no `tsc` errors | Smoke-test the extension's main command/tool once. If it works, note it as «probably safe, monitor.» |
| Extension uses removed API | Propose deletion or rewrite to the user. |

## Deep dive trigger

This repo's `node_modules/@earendil-works/pi-coding-agent` is a **junction** to the global CLI (same files as `docs/pi-local-map.md`). Do not `npm i` a second copy to "refresh types" — after `npm i -g @earendil-works/pi-coding-agent`, `tsc` already sees the new version. If junctions are missing, `python scripts/link-pi-from-global.py`.

Only investigate source inside that `dist/` if:
- The CHANGELOG is vague about a breaking change.
- `tsc` passes but runtime behavior is wrong.
- You need the exact new type signature to write a fix.

Otherwise, trust the CHANGELOG and type checker.
