# Pi Version Sync — Agent Guide

How to check if extensions need updates after a Pi CLI release, without burning tokens.

<!-- BASELINE: 0.76.0 — collection tested and working with this version. Do not analyze versions at or below this baseline. -->

## When to run this

Only when the user explicitly says Pi was updated, or asks whether to upgrade.

## Why both a script and a web check?

The script is a **fast local linter** (≤ 2 s): it finds version delta and obsolete code patterns in your extensions automatically. The agent's web check is a **judgement layer**: it reads the CHANGELOG to decide whether those deltas actually matter for this collection. They complement each other — don't drop the script just because the agent can browse the web.

## Core rule

Do **not** analyze versions at or below the **baseline** (see HTML comment at the top of this file). They are already validated.  
Only look at releases **newer** than the baseline.

## Workflow

### 1. Automated delta check

Run `python scripts/check-pi-sync.py` from the repository root. It detects the **globally installed** Pi version (npm/pnpm/bun → local `node_modules` → `package.json` fallback) and prints:
- Newer releases above the installed version.
- Known obsolete patterns found in local extensions.

Use this output as the starting point. The script is a fast local linter; the agent still reads the CHANGELOG delta to judge red flags.

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
4. **Smoke-test** — run one command or tool from each affected extension to confirm it still works.

### 5. After successful test

Only now update documentation:

1. Bump the `BASELINE` HTML comment at the top of this file to the new Pi version.
2. If you discovered a new obsolete pattern or red flag, add it to the tables below.
3. Update an extension's `README.md` only if its public behavior or install flow changed.
4. Update the root `README.md` only if an extension was added, removed, or changed in purpose.

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
- `renderShell: "self"` on tool overrides → verify still supported after tool rendering changes.

## Decision matrix

| Situation | Action |
|---|---|
| No red flags in CHANGELOG delta | Do nothing. Mention briefly: «Pi update looks safe for this collection.» |
| Red flags but no local matches | Do nothing. No extension uses the affected surface. |
| Red flags + local matches + `tsc` errors | Fix the specific errors. Update the extension's README if public behavior changed. |
| Red flags + local matches + no `tsc` errors | Smoke-test the extension's main command/tool once. If it works, note it as «probably safe, monitor.» |
| Extension uses removed API | Propose deletion or rewrite to the user. |

## Deep dive trigger

Only investigate source code inside `node_modules/@earendil-works/pi-coding-agent/dist/` if:
- The CHANGELOG is vague about a breaking change.
- `tsc` passes but runtime behavior is wrong.
- You need the exact new type signature to write a fix.

Otherwise, trust the CHANGELOG and type checker.
