# model-manager

Dynamic provider and model registration with a TUI.

## What it does

- Lets the user manage custom providers and models via `/mm` (or `/model-manager`).
- Registers curated providers via `pi.registerProvider()` on `session_start` (not on `session_tree` — same ModelRuntime, nothing to replace).
- Remembers the last used model per provider (`model_select` event).
- Supports model sync for **OpenRouter**, **OpenCode Go**, and **NanoGPT**.
- Pulls **model specs on demand** from models.dev (`Update model specs` in the provider detail) for models Pi's catalog does not know yet.
- Allows hiding providers you never use, with a dedicated **Hidden Providers** screen to restore them.
- Hides the Grok 4.5+ thinking **summary** in the TUI (`/grok-think`, default ON). Display only.

## Syncable providers

Sync fetches the public model list, lets the user multi-select models, and registers only the selection as a curated provider.

| Provider | Sync endpoint | API key source |
|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1/models` | `auth.json` key for `openrouter`, or `OPENROUTER_API_KEY` env |
| `opencode-go` | `https://opencode.ai/zen/go/v1/models` | `auth.json` key for `opencode-go`, or `OPENCODE_API_KEY` env |
| `nano-gpt` | `https://api.nano-gpt.com/api/v1/models?detailed=true` | `auth.json` key for `nano-gpt`, or `NANOGPT_API_KEY` env |

**NanoGPT host trap:** the documented base URL `https://nano-gpt.com/api/v1` sits behind a
Vercel bot checkpoint and answers programmatic clients with **403 + HTML** (curl, Node
`fetch`). `api.nano-gpt.com` serves the identical API without it — `NANOGPT_BASE_URL` in
`wire-compat.ts` points there; do not "fix" it back to `nano-gpt.com`.

NanoGPT is **not** a built-in Pi provider, so it has no catalog entry and must exist before
`/mm` can curate it: add it once via `/mm` → **Add Custom Provider** with id `nano-gpt`,
base URL `https://api.nano-gpt.com/api/v1`, API `openai-completions`. That creates the
managed record (baseUrl/apiKey/api) which makes the provider curatable; the sync screen and
`refreshModels` then work as for the built-in two.

The local **infer** provider (registered by `infer-local`, not curated here) gets the same kind of first row: **Refresh from gateway** (`r` or Enter). It does not open a sync checklist — one probe rewrites that provider's rows. The row is absent if `infer-local` is not loaded. Refresh all does not probe it.

To sync, open the provider detail (`Enter` on a provider) and choose **Sync … models** (first item), or press `s`. On the sync screen: **Space** toggles a model, **a** selects/deselects all (or the current filter), **/** opens filter, **Enter** saves. Confirming with no models selected disables curation and restores Pi's built-in configuration for that provider. Re-opening sync pre-checks previously curated models.

## Startup default model

Pi reads `settings.json` (`defaultProvider` + `defaultModel`) when a **new** session
starts, before extensions load — the same two keys Pi's `/model` → `Ctrl+S` writes.
`/mm` owns them so the model manager stays the single place for models:

- **Settings → Default model (Pi startup)** — picker over pinned favorites and
  `(Pi built-in default)` (clears both keys). Provider-only favorites resolve to
  that provider's latest model.
- **`d`** on a favorite row sets it in one keystroke.

The value shows in Settings and the matching favorite row is marked `◆` +
`startup default`. Subview of `/mm` — never a nested `ui.select` (same rule as
role mapping).

Notes:

- Only a *new* session uses it; `-c` / `--resume` keeps the model saved in that
  session, and model-manager never overrides a model mid-session.
- `lastUsedModel` / `useLatestDefault` are unrelated: they are `/mm`'s per-provider
  “default:” display and what a provider-only favorite or `u` resolves to.
- `writePiDefault()` refuses to write when `settings.json` exists but does not
  parse, so a corrupt file cannot lose every other setting.
- The default is a plain model id: if the model disappears (e.g. a host
  `models.json` entry removed after a Pi update), Pi falls back to its built-in
  choice and the Settings row shows the stale value until you pick again.

## Grok thinking summary (display)

Not context-guard — this is a model-family TUI filter. xAI Grok 4.5+ does not expose the real CoT; the gray panel is an independent summary (see `docs/pi-provider-payloads.md`).

Default **ON**. `registerMarkdownTransformer` on `assistant-thinking` replaces the body with `Thinking...`. White `type: text` is untouched. Encrypted replay / effort unchanged.

Match is **AND** of two checks (`model-manager/grok-think.ts`):

| Check | Hits | Misses |
|---|---|---|
| **id or name** after whitespace→`-`, `grok-4.N` minor ≥ 5 | `grok-4.5`, `grok-4.6` (also former host label `grok 4.6 f`) | `grok-4.3`, `grok-build-0.1`, `grok-4.6f` |
| **transport** | provider `xai`, `opencode`, `opencode-go`; baseUrl `api.x.ai` / `cli-chat-proxy.grok.com` | `openrouter` unless its baseUrl is xAI |

Uses the **current** model (`session_start` + `model_select`). Mid-session switch to Grok also collapses older thinking in the scrollback. Already-painted turns do not re-transform until reload. Toggle: `/grok-think hide` / `show` (`off`=`hide`). `/mm` → Settings is `hidden`/`shown`. Persisted: `model-manager.json` → `global.hideGrokThinking`.

## Favorite model cycle hotkeys

Register keyboard shortcuts that switch the active model to the next/previous model in your **Pinned Favorites** list. Cycle order = list order (1, 2, 3… in `/mm`).

| Preset | Previous model | Next model |
|---|---|---|
| `ctrl+f2` (default) | `Ctrl+F2` | `Ctrl+F3` |
| `f2` | `F2` | `F3` |
| `ctrl+shift+arrows` | `Ctrl+Shift+↑` | `Ctrl+Shift+↓` |
| `disabled` | — | — |

The cycle only includes favorites that resolve to a concrete model (provider favorites resolve to their default model). If the agent is currently streaming, the shortcut is ignored. If the target model has no API key, the switch fails with a warning.

Choose the preset in `/mm` → **Settings** → **Favorite model cycle hotkeys**. Changing the preset requires a Pi reload (`/reload`) because shortcuts are registered at extension startup.

Fallback (no hotkey / F-keys swallowed by terminal): `/fav` or `/fav next` / `/fav prev`.

Cycle only walks **resolved** favorites (pin with `*` in `/mm`). Unresolvable or no-key models are skipped with a warning.

### Reorder favorites

On a favorite row in `/mm` (filter must be off):

| Key | Action |
|---|---|
| `[` or `K` | Move favorite up |
| `]` or `J` | Move favorite down |

Order is persisted in `model-manager.json` → `favorites[]` and is both the on-screen sequence and the hotkey cycle ring.

## Model → role mappings

`/mm` → **Settings** → **Model → role mappings**, or press **`m`** on a pinned favorite. Only **pinned favorites** are listed. Provider-only favorites resolve to that provider’s default model before mapping. `role-sw` applies the map on `model_select` **and** on `session_start` for the current model (startup model never emits `model_select`).

Mappings: `~/.pi/agent/settings.json` → `roleSwitcher.modelRoleMap` (`providerId::modelId`).

Values are role **family aliases** (`agent-core`, not `agent-core-v3`), resolved by `role-sw` at apply time — a version bump never invalidates a mapping. The picker shows the same alias list as `/role`.

Role assignment is a **subview** of `/mm` — never a nested `ui.select` inside `ui.custom`. Nested dialogs leave the outer custom promise pending and make `/mm` appear dead until a full Pi reload.

## Session model scope (`ctx.scopedModels`, Pi >= 0.83.0)

When the session is scoped via `--models` / `enabledModels`, Pi exposes the resolved list as `ctx.scopedModels` (empty = no scoping). Model-manager uses it as follows:

- **Favorite cycle** (`/fav`, hotkeys) only walks favorites that resolve **inside** the session scope. If every favorite is out of scope, the cycle warns instead of switching.
- **Pinned thinking level** from a scope pattern (e.g. `opencode-go/*:high`) is applied via `pi.setThinkingLevel` after a successful `setModel`.
- **/mm UI** shows a scope summary on the main and provider screens; favorites and model rows outside scope are tagged `out of scope`. Selecting such a model still works (explicit user action) and the notify line notes it.

Scope is read-only from the extension side — change it with Pi's own `/scoped-models` or CLI flags.

## Dynamic catalog refresh (`refreshModels`, Pi >= 0.80.8)

Curated **OpenRouter** and **OpenCode Go** registrations attach `ProviderConfig.refreshModels`. Pi calls it on model-selector open, `pi update --models`, and `/mm` → **Refresh all** (`await ctx.modelRegistry.refresh()`).

Behavior:

1. Offline / aborted → rebuild curated defs from `cachedModels` + built-in catalog (never drops managed IDs).
2. Online → re-fetch the remote list, re-enrich **only** `managedModelIds`, persist fresher cache to `model-manager.json`, return that list to Pi.
3. Never publishes the full remote catalog — curation stays authoritative.

## Important behaviors

- Config is stored in `~/.pi/agent/model-manager.json`, not in `settings.json`.
- Saves return success/failure: settings toggles notify **Settings saved** (or an error); role maps notify **Saved: key → role**; silent paths (last-used model) only notify on failure.
- `applyCuratedRegistrations()` registers enabled curatable providers on `session_start`. Same-process repeats with unchanged curation are skipped; `unregister` runs only when replacing a previous apply (or dropping curation). Built-in providers other than OpenRouter and OpenCode Go are left to Pi.
- Startup default model is Pi's own `settings.json` → `defaultProvider`/`defaultModel`, written from `/mm` → Settings → **Default model (Pi startup)** or `d` on a favorite row. The old `model-manager.json` → `global.defaultProvider` is gone: it was a *second* default that ran 2–3 s after Pi had already picked its own, so a `/mm` change never moved the startup model. `model-manager` no longer calls `setModel` on `session_start` at all.
- Custom providers added through the TUI are saved and re-registered automatically.
- Built-in providers are detected and not duplicated.
- Hidden providers are no longer shown on the main list; open **Quick Actions > Hidden providers** to restore them. For custom/OpenRouter/OpenCode Go providers hiding also disables them.
- Auth keys resolve via `ctx.modelRegistry.getApiKeyForProvider()` (not removed `authStorage`).

## How curation interacts with built-in and custom providers

- **Custom providers already defined in `models.json`** are left completely alone.
  The manager only hides/shows them and remembers `lastUsedModel` / favorites.
  It never unregisters or re-registers them, so their `headers`, `compat`,
  env-key (`$KIMI_API_KEY`), `defaultModel`, etc. stay intact.
- **Custom providers added through the TUI** can be curated. When disabled/empty
  they are unregistered.
- **Built-in providers** (`opencode-go`, `openrouter`, etc.) are only overridden
  when you actually curate models via sync. If a built-in provider has no curated
  models, the manager does **not** unregister it, so Pi's default configuration
  (headers, compat, pricing, etc.) stays intact.
- When curating a built-in provider, model defs are resolved in this order:
  1) **Pi built-in catalog** (`getModel` from pi-ai) — authoritative api/compat/maxTokens;
  2) live registry if metadata looks complete; 3) enriched sync cache;
  4) bare defaults with provider-safe `compat` (OpenCode Go always gets
  `maxTokensField: "max_tokens"`). Sync stubs alone are not enough: without
  `compat`, Pi sends `max_completion_tokens` and OpenCode Go returns 400.
- **Wire-compat:** prefer catalog as-is; only named profiles for known gaps
  (`wire-compat.ts`):
  - **Kimi on OpenCode Go/Zen** → same wire as stock `kimi-k2.6` (deepseek
    thinking format, no dual `reasoning_effort`, `requiresReasoningContent…`,
    sane maxTokens). Stock `kimi-k2.7-code` omits this and 400s on Go.
  - **Kimi/DeepSeek elsewhere (e.g. OpenRouter)** → only
    `requiresReasoningContentOnAssistantMessages` + maxTokens headroom.
  - **maxTokens ≈ contextWindow** → cap to ~context/4 so turn-1 max_tokens
    cannot blow the request limit.
  - **Prompt-cache flags** — deliberately **not** managed here. Pi only sends
    `prompt_cache_retention`/`prompt_cache_key` under `PI_CACHE_RETENTION=long`,
    which this host does not set (removed 2026-09-25: no measured beneficiary,
    and Z.ai 400s on the field). The trivia and the per-model fix recipe live in
    `docs/pi-provider-payloads.md` §3 — fix per model if a strict upstream ever
    shows up again.
  Applied on resolve / enrich / `session_start` cache repair.
- When curating a **custom provider added via /mm**, the manager preserves the
  provider-level `headers` (e.g. a custom `User-Agent`) taken from the registry
  models.

## Manual specs from models.dev (`Update model specs`)

Pi's built-in catalog lags new models. When `getModel()` misses a curated model,
the fallback in `opencode.ts` invents `contextWindow: 128000` / `maxTokens: 65536`.
That number is a placeholder, not a limit — `deepseek-v4.1-flash` on OpenCode Go
is 1M/384k. Pi 0.84.4 and 0.85.1 shipped no catalog entry for it (which is why the manual
models.dev route existed); **1.0.1 ships it stock at 1M/384k**, so an upgrade does fix that one —
re-check `pi --list-models` before pulling specs by hand.

Fix: a **manual** pull from `https://models.dev/api.json` in the provider detail
(`Enter` on the `→ Update model specs (models.dev)` row, shown only for
`MODELS_DEV_PROVIDERS` = `opencode`, `opencode-go`, `openrouter`).

Deliberately on demand — nothing is wired to `session_start`, to the model
selector, or to a timer:

- The payload is ~4.7 MB; it is fetched only when the row is chosen.
- The filtered result (curated IDs of that provider only) is written to
  `ManagedProvider.overrides` in `model-manager.json` — a few hundred bytes.
  Runtime lookups never touch the network or the big file; `loadConfig()` already
  runs once per session.
- `specsPulledAt` records the pull and is shown in the provider header as
  `Specs (models.dev): pulled YYYY-MM-DD` / `never pulled`.
- Offline / no entry → warning notify, nothing written.

Precedence: **catalog → provider fallback → `overrides` last**, applied in
`patchCuratedModelDef()`. Overrides therefore survive `repairManagedCaches()` and
`refreshModels` (which rewrite `cachedModels`), and
`providerCurationFingerprint()` includes `overrides` so `apply()` actually
re-registers. Applied *before* `sanitizeMaxTokens()` so the ≈context/4 ratio guard
still protects a hand-set `maxTokens`.

Fields stored per model: `contextWindow`, `maxTokens`, `input` (real config),
`costInput` / `costOutput` / `costCacheRead` / `costCacheWrite`, plus
`inputModalities`, `outputModalities`, `knowledge` (**display only**).

`cost*` is USD per **1M** tokens — the same unit as Pi `Model.cost`
(cross-check: `kimi-k3` = 3/15 in both models.dev and the shipped catalog).
models.dev `cost.tiers` (e.g. `minimax-m3` doubles past 512k context) is ignored;
only the base rate is stored, which is all Pi can express. A catalog miss means
`cost: 0`, so `ui-theme` never renders the footer / turn-log `$`
(`if (t.cost > 0)`). The pull stores the price on the override; already-pulled
overrides (no `cost*`) and a curate without a pull are healed at resolve time
from `CATALOG_GAP_COST` in `wire-compat.ts` — **empty since 1.0.1** (`deepseek-v4.1-flash`,
its only row, is now catalogued at 0.15/0.6); add a row only for a model
`pi --list-models` does not show — so `$` appears without a re-pull. A later pull
or catalog entry still wins.

`input` is the important one: Pi decides whether to send or strip images with
`model.input.includes("image")` (`downgradeUnsupportedImages` in the runtime), and
a model absent from the catalog keeps the `["text"]` fallback — so the row
advertises vision while Pi replaces every image with *"(tool image omitted: model
does not support images)"*. The pull therefore maps `modalities.input` down to
Pi's expressible set (`text`/`image`; `video`/`pdf`/`audio` stay display-only) and
writes it as `input`. Cross-checked against Pi's own opencode-go catalog: the
derived value matches for every model the catalog has (`deepseek-v4-flash` →
`text`, `kimi-k3`/`kimi-k2.7-code`/`minimax-m3` → `text+image`) and only adds
`image` for a model the catalog genuinely lacks (`deepseek-v4.1-flash` was the original case — 1.0.1 now ships it as `text+image`, so nothing is added for it). An override that has
`inputModalities` but no `input` (pulled before this existed) is healed at resolve
time by deriving `input` from it, so no re-pull is needed. `video`/`pdf`/`audio`
in the row are informational — Pi cannot send them regardless.

Row display (`global.displaySpecs` ON):

```
[ ] * DeepSeek V4.1 Flash   1M ctx · 384k max · text+image → text · know 2025-05
```

Modalities fall back to the plain Pi `input` (`text+image`) when no pull happened;
`know <YYYY-MM>` appears only when models.dev has a cutoff. Token counts are
compact (`1M`, `384k`) rather than `toLocaleString()`, so the added fields fit one
row. `overrides` is also hand-editable in `model-manager.json` (e.g. correcting a
stale models.dev value without another pull).

## Hidden providers

- Press `h` on a visible provider to hide it.
- Open the hidden providers screen from the main list: **Quick Actions > Hidden providers (N)** — there is no dedicated hotkey on purpose (`h` stays "hide the selected one"; a capital-letter twin is forgotten by its author within a week).
- In the hidden screen, select a provider and press `Enter` or `h` to restore it.
- The screen lists a hidden provider even when it has **no registered models** (host P-6b decat blanks unused built-in catalogs, so most hidden built-ins register zero models). Zero-model rows show `(0 managed · 0 available)` and disappear from the main list again after restore — restoring only flips the hidden flag.
- On the provider detail, the `/` filter does not swallow action keys: **Space** (manage) and **`*`** (favorite) stay live while typing, arrows navigate the matches, and closing/clearing the filter (Enter/Esc) lands the cursor back on the model it sat on — not the top of the list.

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

**Cost units (easy to get wrong):** Pi `Model.cost` is USD per **1M** tokens — the
shipped catalogs confirm it (`openai.json` gpt-4 = 30/60, `kimi-coding.json` k3 =
3/15). A provider that quotes per-token (OpenRouter) or per-1K (NanoGPT's
`cacheReadInputPer1kTokens`) must rescale inside `<provider>ModelToCached`.
OpenRouter's mapping did not and every curated model it created was priced 10⁶×
too low until that was fixed.

## Usage quotas

- `/usage` opens the quota overlay. Active model’s provider is fetched first
  (`fetchActiveProviderUsage`); `R` refreshes every auto/manual provider.
- Auto-detect:
  - **Kimi Code** — `baseUrl` contains `api.kimi.com/coding` → `…/v1/usages`
    (`/v1` suffix normalized away first).
  - **OpenCode Go** — `baseUrl` contains `opencode.ai/zen/go` → `…/v1/usage`.
    Live shape (verified 2026-09-25): `{"usage": {"rolling"|"weekly"|"monthly":
    {"status", "percent", "resetsAt"}}}` — integer % (0–100) of each window's
    dollar budget; dollar limits are NOT on the wire. Mapped onto 100-unit
    windows (`Weekly limit`, `Rolling 5h limit`, `Monthly limit`), same
    convention as the xAI weekly-% meter. `≈$` = official monthly limit of the
    active model (`OPENCODE_GO_MONTHLY_LIMITS` in `usage.ts`, from docs/go
    "Usage limits": windows are 20%/50%/100% of monthly). Deliberately NO
    calib override (unlike Kimi/xAI): the public table defines the meter —
    opencode computes % from these dollar budgets — while ΣΔapiCost/ΣΔ%
    would average whatever models the pairs used ($0.10–$4 input range,
    off-peak/peak DeepSeek). Calib points are not even recorded for
    opencode-go. Endpoint added upstream 2026-08-11 (sst/opencode #16513);
    opencode itself still has no built-in `/usage` TUI command (issues
    #9281/#32672 open).
  - **xAI / Grok subscription** — provider id `xai`, or `baseUrl` contains
    `api.x.ai` / `cli-chat-proxy.grok.com`. Billing via unofficial
    `cli-chat-proxy.grok.com/v1/billing`: weekly
    `?format=credits` (`creditUsagePercent`) is the live meter; plain monthly
    often returns `monthlyLimit=0` on current Grok Build / unified plans
    (same as native UI — weekly only) and is omitted when inactive. Needs
    subscription OAuth (`/login xai`); plain `XAI_API_KEY` usually fails.
    Auth/UA/ToS: `docs/xai-grok-oauth.md`.
- Extra providers can be added manually in `model-manager-usage.json`.
- Windows are grouped under one header per provider, so several API keys on
  the same endpoint (separate provider ids in `models.json` + `auth.json`)
  stay distinguishable.
- `r` refreshes the active provider, `R` all providers, `p` pins a window
  (persisted, floats to top), `i` shows the raw JSON response.
- Every live fetch is appended to a rolling history
  (`model-manager-usage-history.json`, 7 days, 1000-entry cap). Rows show
  `since last: +N (age)`, `today: +N`, and `week: +N` (week-to-date since the
  last meter reset; for `Weekly limit` the API `used` is already week-to-date).
  History view (`h`) scrolls the full retained week and has a **Week Σ** column.
- Snapshot for `[cached]` rows: `~/.pi/agent/model-manager-usage-snapshot.json`.
- **Calibration log** (`model-manager-usage-calib.jsonl`): each successful live
  fetch from `/usage` (open / `r` / `R` only) appends one compact point
  (windows + session totals). Formula re-pairs in memory — no derived `d`.
  Auto-prunes: 14 days, unpaired sessions after 3 days, 40/provider, 80
  backstop. Do **not** load this file into the LLM context; rate logic is
  `model-manager/usage.ts`. History (`usage-history.json`, 7 days) is the
  overlay’s today/week counters — separate, leave it.
- **Cost estimates:**
  - **Kimi** quota is a *weighted* unit (docs: `k3` ~2× `k3-256k`, HighSpeed
    ~3×) — neither tokens nor 1:1 requests — so Kimi `≈$` uses calib
    Σ list$(Δtokens) / ΣΔquota (same-session, same-model pairs). List $ is
    computed from official rates (cache at `cacheRead`), not Pi `apiCost`
    (catalog `k3-256k` ships cost=0). Per-model, then same-model blend.
    Cache-bomb pairs (dq<3 and cache ≫ fresh tokens) and weekly-reset
    pairs (do not fall through to 5h) are dropped. No estimate until ≥1
    clean pair. Fallback rates: $3/$15 `k3`/`k3-256k`;
    $0.95/$4 `kimi-for-coding` / `kimi-k2-thinking`; $1.9/$8 highspeed.
    Overlay prints `≈$N list` (not a payment) and, on Weekly, `bar ≈$N list`
    = 100% × $/unit. Operator economics: `docs/kimi-k3-quota.md`.
  - **xAI weekly %:** calib ΣΔsess.apiCost / ΣΔweekly% on consecutive
    *per-session* pairs. `/usage` anytime is safe: drops old SuperGrok
    `monthlyLimit>0`, Δ% < 3, any other session’s `/usage` in the interval
    (parallel windows even if % had not ticked), and $/pct outside 0.20–0.80.
    Live rate ignored until survivors sum to Δ% ≥ 8 — overlay keeps seed
    **~$0.45 list / 1%** (grok-4.5 and 4.6 pooled, same list $2/$6).
    Monthly window: no `$` estimate. Operator economics: `docs/xai-grok-quota.md`.
  - **OpenCode Go %:** pure docs-table conversion, no calib (see the
    OpenCode Go auto-detect entry above). Space Bunny Free (unlimited) is
    intentionally absent from the table → no `$` estimate there.
  - **Other providers:** direct Δ×$/token. Pi core does not read
    `compat.costMultiplier` — rates use `model.cost` only.

## State

- `~/.pi/agent/model-manager.json` — full config (favorites, managed IDs, toggles, hidden provider IDs). No startup default here — see above.
- `~/.pi/agent/settings.json` — `defaultProvider`/`defaultModel` (Settings → **Default model**) and `roleSwitcher.modelRoleMap` (the role-map view, via `role-sw/config`); the only Pi file `/mm` writes.
- Custom session entries with `customType: "model-manager-state"` (lightweight markers).
