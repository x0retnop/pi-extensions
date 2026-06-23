# pi-model-manager

A keyboard-driven TUI extension for managing model providers and models in Pi.

## Where the lists come from

The model manager does **not** maintain its own isolated catalog. It reads the
live model registry from Pi and layers a small amount of extension state on top.

### Providers

The providers list is built from `ctx.modelRegistry.getAll()`:

1. **Built-in providers** shipped with Pi (`anthropic`, `openai`, `openrouter`,
   etc.). They appear automatically as long as Pi knows about them.
2. **Providers added in `~/.pi/agent/models.json`** — overrides and custom
   providers configured there are picked up by the registry and shown here.
3. **Providers registered dynamically** by this extension (custom providers or
   curated OpenRouter).

The manager only stores *your preferences* for each provider (enabled state,
`useLatestDefault`, `lastUsedModel`, managed model IDs, overrides,
hidden/shown state) in `model-manager.json`. It never edits Pi's built-in files
unless you explicitly use Pi's own commands (e.g. `/login`).

### Models

Models inside each provider come from the same live registry:

- Built-in models from Pi + `models.json`.
- OpenRouter models fetched from `https://openrouter.ai/api/v1/models` and
  OpenCode Go models fetched from `https://opencode.ai/zen/go/v1/models` when
  you open a provider and choose **Sync … models**. Selected IDs are cached in
  `model-manager.json` so they survive restarts.
- Custom models added manually for custom providers.

Model curation (marking specific models as managed) is supported for
**OpenRouter**, **OpenCode Go** and **custom providers**. For other built-in
providers the manager can still select and use models, but it cannot hide
individual models from Pi's registry.

When curating a built-in provider, the manager keeps the original model metadata
(headers, compat, specs) from Pi's registry for models Pi already knows. It only
falls back to cached defaults for brand-new models returned by the sync endpoint.

Custom providers already defined in `models.json` are **never** re-registered by
the manager; it only hides/shows them and remembers your last used model and
favorites. This keeps provider-level `headers`, `compat`, env-key references
(`$KIMI_API_KEY`) and `defaultModel` exactly as you configured them.

If you want to curate a custom provider through `/mm`, add it again via
**Add new provider** so the manager owns its connection details.

## Usage

Run `/mm` (or `/model-manager`) to open the model manager.

### Main screen

- **Pinned Favorites** — starred providers/models at the top.
- **Providers** — providers you want to see.
- **Quick Actions** — add provider, hidden providers, global settings, refresh, help.

Hidden providers now have their own screen (press `H`).

### Shortcuts

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate |
| `Enter` | Open provider detail; confirm an action |
| `u` | Use the default/current model for the selected provider or favorite |
| `h` | Hide the selected provider |
| `H` | Open the hidden providers screen |
| `*` | Star/unstar the selected provider/model |
| `/` | Filter the list |
| `g` / `G` | Jump to first/last selectable row |
| `?` | Show help |
| `Esc` / `q` | Close |

### Provider detail

| Key | Action |
|---|---|
| `Enter` | Use the selected model, or sync if the sync row is selected |
| `u` | Use the selected model now |
| `Space` / `x` | Toggle whether a model is managed (curated) |
| `*` | Star/unstar a model |
| `a` | Select all / none |
| `s` | Sync provider models (syncable providers) |
| `n` | Add a custom model (custom providers only) |
| `h` | Hide this provider |
| `/` | Filter models |
| `Esc` / `q` | Back |

## Hiding providers

Press `h` on any provider to hide it. Hidden providers move to the
**Hidden Providers** screen and are removed from the default provider list in
settings. For custom providers and curated OpenRouter/OpenCode Go, hiding also
disables the provider so it disappears from Pi's model selector until you
restore it.

## Configuration

State is stored in `~/.pi/agent/model-manager.json`. You can edit favorites and
toggles manually; the extension merges them with Pi's built-in providers and
`models.json` on load. The `cachedModels` field on a managed provider keeps the
full model definitions fetched from sync endpoints.

## Custom providers

Use **Add new provider** to register a custom provider. Curated models for that
provider are registered dynamically via `pi.registerProvider()`.

## OpenRouter / OpenCode Go

Open the provider detail and choose **Sync … models** to fetch `/v1/models`,
multi-select the ones you want, and curate them. Only selected models will
appear in Pi's normal model selector. To disable curation and restore Pi's
built-in configuration, open sync again and confirm with no models selected.

## Hidden providers

Press `h` on a provider to hide it. Hidden providers live in their own screen:
press `H` on the main screen or select **Hidden providers** from Quick Actions.

## Files Pi uses

| File | Purpose |
|---|---|
| `~/.pi/agent/models.json` | Pi's own provider/model overrides and custom providers. Read-only for this extension. |
| `~/.pi/agent/auth.json` | API keys / OAuth tokens. The manager checks auth status here but does not write to it. |
| `~/.pi/agent/model-manager.json` | Extension state: favorites, managed IDs, toggles, hidden provider IDs, cached sync models. |
