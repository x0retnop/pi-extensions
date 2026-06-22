# model-manager

Dynamic provider and model registration with a TUI.

## What it does

- Lets the user manage custom providers and models via `/mm` (or `/model-manager`).
- Registers curated providers via `pi.registerProvider()` on `session_start` and `session_tree`.
- Remembers the last used model per provider (`model_select` event).
- Supports OpenRouter sync.
- Allows hiding providers you never use, with a dedicated **Hidden Providers** section to restore them.

## Commands

- `/mm` — open the model manager TUI.
- `/model-manager` — alias for `/mm`.

## Important behaviors

- Config is stored in `~/.pi/agent/model-manager.json`, not in `settings.json`.
- `applyCuratedRegistrations()` re-registers all enabled, curatable providers on every `session_start` / `session_tree`. Built-in providers other than OpenRouter are left to Pi.
- If `global.defaultProvider` is set, the extension tries to restore that model on session start.
- Custom providers added through the TUI are saved and re-registered automatically.
- Built-in providers are detected and not duplicated.
- Providers in `global.hiddenProviderIds` are moved to a **Hidden Providers** section in the TUI. For custom/OpenRouter providers hiding also disables them.

## State

- `~/.pi/agent/model-manager.json` — full config (favorites, managed IDs, toggles, hidden provider IDs).
- Custom session entries with `customType: "model-manager-state"` (lightweight markers).

## Source

- `model-manager/index.ts` — commands, TUI, registration flow.
- `model-manager/config.ts` — persistence.
- `model-manager/provider-utils.ts` — built-in vs curated provider logic.
- `model-manager/openrouter.ts` — OpenRouter model sync.
