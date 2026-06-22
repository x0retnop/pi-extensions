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
`useLatestDefault`, `lastUsedModel`, managed model IDs, overrides) in
`model-manager.json`. It never edits Pi's built-in files unless you explicitly
use Pi's own commands (e.g. `/login`).

### Models

Models inside each provider come from the same live registry:

- Built-in models from Pi + `models.json`.
- OpenRouter models fetched from `https://openrouter.ai/api/v1/models` when you
  press **Sync OpenRouter models**. Selected IDs are cached in
  `model-manager.json` so they survive restarts.
- Custom models added manually for custom providers.

Only models marked as **managed** (`[x]`) are passed to `pi.registerProvider()`
as a curated list. Unmanaged models are hidden from Pi's normal `/model` and
`Ctrl+L` selectors, but they remain in the registry until you re-enable them.

## Usage

Run `/mm` (or `/model-manager`) to open the model manager.

### Main screen

- **Pinned Favorites** — starred providers/models at the top.
- **Providers** — list of all known providers with auth status, managed count, and default model.
- **Quick Actions** — add provider, sync OpenRouter, global settings, refresh, help.

### Shortcuts

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate |
| `Enter` | Open provider detail; on a favorite model it also selects it for use |
| `u` | Use the default/current model for the selected provider or favorite |
| `*` | Star/unstar the selected provider/model |
| `/` | Filter the list |
| `?` | Show help |
| `Esc` / `q` | Close |

### Provider detail

| Key | Action |
|---|---|
| `Enter` / `u` | Use the selected model now |
| `Space` / `x` | Toggle whether a model is managed (curated) |
| `*` | Star/unstar a model |
| `a` | Select all / none |
| `s` | Sync from OpenRouter (OpenRouter only) |
| `n` | Add a custom model (custom providers only) |
| `/` | Filter models |
| `Esc` / `q` | Back |

## Configuration

State is stored in `~/.pi/agent/model-manager.json`. You can edit favorites and
toggles manually; the extension merges them with Pi's built-in providers and
`models.json` on load.

## Custom providers

Use **Add new provider** to register a custom provider. Curated models for that
provider are registered dynamically via `pi.registerProvider()`.

## OpenRouter

Use **Sync OpenRouter models** to fetch `/v1/models`, multi-select the ones you
want, and curate them. Only selected models will appear in Pi's normal model
selector.

## Files Pi uses

| File | Purpose |
|---|---|
| `~/.pi/agent/models.json` | Pi's own provider/model overrides and custom providers. Read-only for this extension. |
| `~/.pi/agent/auth.json` | API keys / OAuth tokens. The manager checks auth status here but does not write to it. |
| `~/.pi/agent/model-manager.json` | Extension state: favorites, managed IDs, toggles, cached OpenRouter models. |
