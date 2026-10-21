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
except `settings.json` → `defaultProvider`/`defaultModel`, which is what the
**Default model (Pi startup)** setting and `d` write (Pi itself writes the same
keys from `/model` → `Ctrl+S`).

### Models

Models inside each provider come from the same live registry:

- Built-in models from Pi + `models.json`.
- OpenRouter models fetched from `https://openrouter.ai/api/v1/models`,
  OpenCode Go models fetched from `https://opencode.ai/zen/go/v1/models`, and
  NanoGPT models fetched from `https://api.nano-gpt.com/api/v1/models?detailed=true`
  when you open a provider and choose **Sync … models**. Selected IDs are cached in
  `model-manager.json` so they survive restarts.
- Custom models added manually for custom providers.

Model curation (marking specific models as managed) is supported for
**OpenRouter**, **OpenCode Go**, **NanoGPT** and **custom providers**. For other
built-in providers the manager can still select and use models, but it cannot hide
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

- **Pinned Favorites** — starred providers/models at the top (numbered; order = cycle order).
- **Providers** — providers you want to see.
- **Quick Actions** — add provider, hidden providers, global settings, refresh, help.

Hidden providers now have their own screen (press `H`).

### Shortcuts

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate |
| `[` / `]` (or `K` / `J`) | Reorder selected favorite up/down (list + cycle order) |
| `Enter` | Open provider detail; confirm an action |
| `u` | Use the default/current model for the selected provider or favorite |
| `d` | Make the selected favorite Pi's startup default model |
| `h` | Hide the selected provider |
| `H` | Open the hidden providers screen |
| `*` | Star/unstar the selected provider/model |
| `m` | Map role for the selected favorite |
| `/` | Filter the list |
| `g` / `G` | Jump to first/last selectable row |
| `?` | Show help |
| `Esc` / `q` | Close |

### Provider detail

| Key | Action |
|---|---|
| `Enter` | Use the selected model, or run the selected action row (sync / update specs) |
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

The `overrides` field on a managed provider is manual per-model truth
(`contextWindow`, `maxTokens`, `input`, `displayName`,
`costInput`/`costOutput`/`costCacheRead`/`costCacheWrite`,
`inputModalities`/`outputModalities`/`knowledge`). It wins over Pi's catalog and
is what the provider detail's **Update model specs (models.dev)** row writes —
on demand only, so no 4.7 MB fetch ever happens at startup. `specsPulledAt`
records the last pull and shows up in the provider header. A catalog-gap model
whose override has no `cost*` still gets a known list price at resolve time
(`deepseek-v4.1-flash` → 0.15/0.6 per 1M) so the footer `$` appears without a
re-pull. See `docs/extensions/model-manager.md`.

## Grok thinking summary

On Grok 4.5+ (xAI / OpenCode hop) the gray thinking panel is an xAI **summary**,
not the real chain. `/grok-think` (default hidden) collapses it to `Thinking...`.
White answer text stays. `/grok-think show` or `/mm` → Settings (`shown`) to see it.
Detection: model id `grok-4.N` with N≥5 **and** provider `xai`/`opencode`/`opencode-go`
(or an `api.x.ai` baseUrl). Not a new extension — lives in this one.

## Custom providers

Use **Add new provider** to register a custom provider. Curated models for that
provider are registered dynamically via `pi.registerProvider()`.

## Session model scope

If the session was started with `--models` / `enabledModels`, `/mm` shows the active scope and favorite-cycle hotkeys only walk favorites inside that scope. Out-of-scope favorites and models are tagged in the UI.

## OpenRouter / OpenCode Go / NanoGPT

Curated registrations include `refreshModels`, so Pi's model selector / `pi update --models` / `/mm` → **Refresh all** re-fetch metadata for the curated ID set only (not the full remote catalog).

NanoGPT is not a built-in Pi provider: add it once via **Add new provider**
(id `nano-gpt`, base URL `https://api.nano-gpt.com/api/v1`, API
`openai-completions`). Do not point it at `nano-gpt.com/api/v1` — that host sits
behind a Vercel bot checkpoint that 403s programmatic clients.

Open the provider detail and choose **Sync … models** (or press `s`) to fetch
`/v1/models`, multi-select the ones you want, and curate them. Only selected
models will appear in Pi's normal model selector. Previously curated models are
pre-checked on re-sync.

| Key | Action |
|---|---|
| `Space` | Toggle the selected model |
| `a` | Select all / none (respects the current filter) |
| `/` | Open filter (type to narrow; arrows still navigate) |
| `Enter` | Save curation (0 selected = disable curation) |
| `Esc` | Cancel (or clear filter first if one is active) |

To disable curation and restore Pi's built-in configuration, open sync again
and confirm with no models selected.

**Note:** curated metadata comes from Pi's catalog, then **wire-compat** applies
only named host profiles (e.g. Kimi on OpenCode Go uses the same wire as stock
`kimi-k2.6`). Sync `/models` stubs alone are not enough.

Models whose catalog sets `maxTokens` very close to `contextWindow` are capped
to a safe fraction of the context window before registration. This avoids 400
errors on strict OpenAI-compatible proxies that always receive a `max_tokens`
value.

## Hidden providers

Press `h` on a provider to hide it. Hidden providers live in their own screen:
press `H` on the main screen or select **Hidden providers** from Quick Actions.

## Usage quotas

Run `/usage` to open the usage quota overlay. It fetches the **active**
model’s provider first; `R` refreshes all known usage providers. Auto-detect:

- **Kimi Code** — providers whose `baseUrl` contains `api.kimi.com/coding`.
- **OpenCode Go** — providers whose `baseUrl` contains `opencode.ai/zen/go`
  (maps to `/zen/go/v1/usage` once that endpoint is live).
- **xAI / Grok subscription** — provider id `xai`, or `baseUrl` containing
  `api.x.ai` / `cli-chat-proxy.grok.com`. Uses unofficial
  `cli-chat-proxy.grok.com/v1/billing`: weekly `?format=credits` is the live
  meter; monthly is omitted when the plan reports `monthlyLimit=0` (common on
  Grok Build / unified billing — native UI is weekly-only too). Requires
  subscription OAuth (`/login xai`); API keys alone usually 401.
  Auth/UA/ToS: `docs/xai-grok-oauth.md`.

You can also add any provider manually to `~/.pi/agent/model-manager-usage.json`.
The `/v1` suffix of the provider `baseUrl` is normalized away before appending
`/v1/usages` or `/v1/usage`, so both `.../coding` (anthropic) and
`.../coding/v1` (openai-completions) variants work. xAI billing URL is fixed
(not derived from model `baseUrl`).

Rows are grouped by provider — one header per provider (display name + id,
`[cached]` when the data comes from the snapshot), one line per quota window:

```text
Kimi Code · main (anthropic)  (kimi-main-ant)
  Weekly limit ★  ██████░░░░░░░░░░  60/100 · 40 left · 60% · resets in 3d
    since last: +5 (2h ago) · today: +23
  5h limit        ░░░░░░░░░░░░░░░░  0/50 · 50 left · 0%
```

This grouping is what keeps multiple API keys on the same endpoint (e.g. two
Kimi accounts) readable: each key is its own provider id with its own header.

### History and deltas

Every live fetch is appended to a rolling history
(`~/.pi/agent/model-manager-usage-history.json`, kept for 7 days, capped at
1000 entries). Each window row shows compact deltas computed from it:

- `since last: +N (Xh ago)` — consumption since the previous fetch of this
  window. Run `/usage` at the start and end of a work session to see what the
  session cost.
- `today: +N` — consumption since the first fetch of the day (local midnight).
- `week: +N` — week-to-date since the last meter reset. For `Weekly limit`
  the API `used` is already week-to-date, so this matches the bar.

Deltas appear only when an earlier fetch exists to compare against; the
just-made fetch never zeroes its own delta.

Cost estimates: the `≈$N list` figures convert a quota delta into API-list
dollars (not the subscription payment). Weekly rows also show `bar ≈$N list`
= full window × the calib rate.

- **Kimi:** weighted quota units → calib Σ list$(Δtokens) / ΣΔquota
  (same-session, same-model). List $ from official rates including cache;
  not Pi `apiCost`. Per-model, then blend. Cache-bomb pairs and weekly-reset
  pairs (no 5h fall-through) dropped. No estimate until ≥1 clean pair.
  Missing registry `cost` → official list prices ($3/$15 `k3`/`k3-256k`;
  $0.95/$4 `kimi-for-coding` / `kimi-k2-thinking`; $1.9/$8 highspeed).
  How to read vs the Allegretto plan: `docs/kimi-k3-quota.md`.
- **xAI weekly %:** calib ΣΔsess.apiCost / ΣΔweekly% on consecutive
  per-session pairs. `/usage` anytime is safe: drops old SuperGrok
  `monthlyLimit>0`, Δ% < 3, any other session’s `/usage` in the interval,
  and $/pct outside 0.20–0.80. Live rate ignored until ΣΔ% ≥ 8 — overlay
  keeps seed **~$0.45 list / 1%** (4.5+4.6 pooled). Monthly window has
  no `$` estimate (often disabled on current plans).
- **Other:** direct Δ×$/token.

Pi core does not read `compat.costMultiplier` — rates use `cost` only.

The latest snapshot (for `[cached]` rows of providers not fetched this run) is
stored in `~/.pi/agent/model-manager-usage-snapshot.json`.

### Manual providers

Create or edit `~/.pi/agent/model-manager-usage.json`:

```json
{
  "providers": [
    { "providerId": "my-provider", "usageUrl": "https://api.example.com/v1/usages" }
  ]
}
```

The extension will use `ctx.modelRegistry.getApiKeyForProvider()` to resolve
the API key for each configured provider.

### Shortcuts in usage overlay

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate window rows |
| `r` | Refresh the active provider |
| `R` | Refresh all providers |
| `p` | Pin/unpin the selected window (floats to top, persisted) |
| `i` | Inspect the raw JSON response of the selected provider |
| `d` | Clear rolling history for the selected **window** (with confirmation) |
| `x` | Clear rolling history + snapshot for the whole **provider** (with confirmation) |
| `h` | Open history view for the selected window |
| `Esc` / `q` | Close overlay |

In the history view:

| Key | Action |
|---|---|
| `↑` / `↓` | Scroll records |
| `w` | Toggle between this window and all windows of the provider |
| `g` | Toggle daily summary / individual records |
| `Esc` / `q` | Back |

## Favorite model cycle hotkeys

Global shortcuts cycle the active model through your **Pinned Favorites**:

| Preset | Previous | Next |
|---|---|---|
| `ctrl+f2` (default) | `Ctrl+F2` | `Ctrl+F3` |
| `f2` | `F2` | `F3` |
| `ctrl+shift+arrows` | `Ctrl+Shift+↑` | `Ctrl+Shift+↓` |
| `disabled` | — | — |

The shortcut is ignored while the agent is streaming and when the target model has no API key. Choose the preset in `/mm` → **Settings** → **Favorite model cycle hotkeys**. A `/reload` is required to change the registered keys.

Cycle order follows the numbered favorites list. Reorder with `[` / `]` (or `K` / `J`) on a favorite row in `/mm` — no reload needed for order changes.

## Model → role mappings

`/mm` → **Settings** → **Model → role mappings** lets you bind any model to a role file from `role-sw/roles/*.md`. When the model changes, `role-sw` automatically switches to the mapped role before the next turn. This works for switches made via the palette (`Ctrl+P`), `/mm`, or the cycle hotkeys.

Mappings live in `~/.pi/agent/settings.json` under `roleSwitcher.modelRoleMap` (key: `providerId::modelId`).

## Startup default model

Pi starts every new session with `settings.json` → `defaultProvider`/`defaultModel`.
`/mm` is the single place that owns it:

- `/mm` → **Settings** → **Default model (Pi startup)** — picker over pinned favorites
  (plus *(Pi built-in default)*, which clears both keys).
- `d` on a favorite row sets it directly.

The current default is shown in Settings and marked with `◆` on its favorite row.
Pi applies it before extensions load, so no 2–3 s late model switch — and unlike
the removed `model-manager.json` → `global.defaultProvider` it also applies to
sessions that were never opened in `/mm`. A resume (`-c` / `--resume`) keeps the
model saved in that session; the default only decides a *new* session.

## Files Pi uses

| File | Purpose |
|---|---|
| `~/.pi/agent/settings.json` | Pi's settings. `/mm` writes only `defaultProvider`/`defaultModel` (startup model) here. |
| `~/.pi/agent/models.json` | Pi's own provider/model overrides and custom providers. Read-only for this extension. |
| `~/.pi/agent/auth.json` | API keys / OAuth tokens. The manager checks auth status here but does not write to it. |
| `~/.pi/agent/model-manager.json` | Extension state: favorites, managed IDs, toggles, hidden provider IDs, cycle hotkeys, cached sync models. |
| `~/.pi/agent/model-manager-usage.json` | Manual list of providers to query for `/usage`. |
| `~/.pi/agent/model-manager-usage-snapshot.json` | Last `/usage` snapshot for `[cached]` rows. |
| `~/.pi/agent/model-manager-usage-calib.jsonl` | Compact `/usage` points (no auto poll). Auto-pruned (14d, unpaired after 3d). Drives Kimi `$` and may update the xAI seed. Do not dump into LLM context. |
| `~/.pi/agent/model-manager-usage-history.json` | Rolling fetch history (7 days) for `since last` / `today` / `week` deltas. |
