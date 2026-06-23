# model-manager

Dynamic provider and model registration with a TUI.

## What it does

- Lets the user manage custom providers and models via `/mm` (or `/model-manager`).
- Registers curated providers via `pi.registerProvider()` on `session_start` and `session_tree`.
- Remembers the last used model per provider (`model_select` event).
- Supports model sync for **OpenRouter** and **OpenCode Go**.
- Allows hiding providers you never use, with a dedicated **Hidden Providers** screen to restore them.

## Syncable providers

Sync fetches the public model list, lets the user multi-select models, and registers only the selection as a curated provider.

| Provider | Sync endpoint | API key source |
|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1/models` | `auth.json` key for `openrouter`, or `OPENROUTER_API_KEY` env |
| `opencode-go` | `https://opencode.ai/zen/go/v1/models` | `auth.json` key for `opencode-go`, or `OPENCODE_API_KEY` env |

To sync, open the provider detail (`Enter` on a provider) and choose **Sync … models** (first item), or press `s`. Confirming sync with no models selected disables curation and restores Pi's built-in configuration for that provider.

## Commands

- `/mm` — open the model manager TUI.
- `/model-manager` — alias for `/mm`.

## Important behaviors

- Config is stored in `~/.pi/agent/model-manager.json`, not in `settings.json`.
- `applyCuratedRegistrations()` re-registers all enabled, curatable providers on every `session_start` / `session_tree`. Built-in providers other than OpenRouter and OpenCode Go are left to Pi.
- If `global.defaultProvider` is set, the extension tries to restore that model on session start.
- Custom providers added through the TUI are saved and re-registered automatically.
- Built-in providers are detected and not duplicated.
- Hidden providers are no longer shown on the main list; use **Quick Actions > Hidden providers** (or press `H`) to open the hidden providers screen. For custom/OpenRouter/OpenCode Go providers hiding also disables them.

## How curation interacts with built-in and custom providers

- **Custom providers** from `models.json` or added through the TUI are left alone unless you explicitly enable them in the manager (e.g. set `managedModelIds` or add models). When disabled/empty they are unregistered.
- **Built-in providers** (`opencode-go`, `openrouter`, etc.) are only overridden when you actually curate models via sync. If a built-in provider has no curated models, the manager does **not** unregister it, so Pi's default configuration (headers, compat, pricing, etc.) stays intact.
- When curating a built-in provider, the manager first looks at Pi's existing registry models for that provider and keeps their full metadata (specs, headers, compat). Fallback cached definitions are only used for models that Pi does not already know about. This prevents custom `User-Agent` headers or model compat flags from being lost for known models.

## Hidden providers

- Press `h` on a visible provider to hide it.
- Press `H` on the main screen (or select **Hidden providers** in Quick Actions) to open the hidden providers screen.
- In the hidden screen, select a provider and press `Enter` or `h` to restore it.

## Adding a new syncable provider

To add another provider that exposes an OpenAI-compatible `/models` endpoint:

1. Create a fetcher module (e.g. `model-manager/<provider>.ts`) exporting:
   - `fetch<Provider>Models(apiKey?)`
   - `<provider>ModelToCached(m)` -> `CachedModel`
2. Import the fetcher in `model-manager/index.ts` and add the provider to `SYNCABLE_PROVIDERS`:
   ```ts
   "my-provider": {
     label: "My Provider",
     fetch: (ctx) => {
       const auth = ctx.modelRegistry.authStorage.get("my-provider");
       const apiKey = auth?.type === "api_key" ? auth.key : process.env.MY_PROVIDER_API_KEY;
       return fetchMyProviderModels(apiKey);
     },
     toCached: myProviderModelToCached,
   },
   ```
3. If the provider is **built-in**, add a matching branch in `buildCuratedProviderConfig()` inside `model-manager/provider-utils.ts` so the extension knows how to build its `ProviderConfig` (base URL, API key env variable, etc.).
4. Update this doc and `model-manager/README.md`.

## State

- `~/.pi/agent/model-manager.json` — full config (favorites, managed IDs, toggles, hidden provider IDs).
- Custom session entries with `customType: "model-manager-state"` (lightweight markers).

## Source

- `model-manager/index.ts` — commands, TUI, registration flow.
- `model-manager/config.ts` — persistence.
- `model-manager/provider-utils.ts` — built-in vs curated provider logic.
- `model-manager/openrouter.ts` — OpenRouter model sync.
- `model-manager/opencode.ts` — OpenCode Go model sync.
- `model-manager/ui/provider-sync.ts` — generic model-list sync screen.
- `model-manager/ui/hidden-providers.ts` — hidden providers screen.
