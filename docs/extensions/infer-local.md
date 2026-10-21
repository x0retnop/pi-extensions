# infer-local

Stand-in for a hand-written `infer` provider in `models.json`. Registers the last stored
gateway snapshot and then does nothing — no startup probe, no `refreshModels`, no slash
command. The gateway (`C:/10x001/infer-gateway`, port 8090) is contacted only from
`/mm` → this provider → **Refresh from gateway**.

## Why it exists

The gateway routes by `model = <alias>`, and the alias is bound in
`infer-gateway/config/backends.yaml` and rebound by server_CFG **Swap LLM** on every local
model change. A `models.json` entry that hardcodes the alias (plus one provider per
`X-Infer-Preset` value) therefore goes stale on every swap and shows the same model twice in
`/mm` — the live alias was `gemma4-E4B-uncensored` while `models.json` still advertised
`Qwen3.5-Qwopus-9B-Q8_0`, and requests failed with the gateway's `model_not_found`.

## What it registers

Once, at extension load, from `~/.pi/agent/infer-local-cache.json` (no network). `session_start`
re-registers only when `infer-local.json` changed since load — still from the cache, still no
probe. Unchanged config does not call `registerProvider` again: that call fires Pi's
`refresh({ allowNetwork: false })` for every dynamic provider.

- provider id from config, default **`infer`** — same id as the existing `models.json` entry,
  so Pi merges the two: `models.json` supplies nothing that matters, the extension's
  `models` (a **full replacement** — `applyExtension` never merges model lists) is the live
  list. Provider-level `baseUrl`/`api`/`compat` are taken from the extension defaults and can
  be overridden in `models.json` or `infer-local.json`.
- one model row per **chat** alias: `id` = exact gateway alias (it is the route key — a
  suffix like `alias@preset` would 404), `contextWindow` = `ctx_max` from `/v1/profiles`,
  `input` = `["text","image"]` only when the profile says `capabilities.vision`,
  `maxTokens` = `ctx/4` capped at 32768 (the gateway 400s on `input + max_tokens > ctx_max`).
- **one preset pin on the base row**: `defaultPreset: "agents"` sends `X-Infer-Preset` for
  that provider, so a single row/model entry always runs with the tuned sampling — this is
  the recommended shape because Pi headers are provider-level and an extra row would mean a
  second provider in `/mm`.
- optional **extra preset rows** from `presets: [...]` in `infer-local.json`. Presets are a
  per-request header in the gateway (`X-Infer-Preset`) and Pi headers are per provider, so one
  provider per preset is the only way to expose them: `sub-agents-recon` →
  `infer-sub-agents-recon`, whose model rows are the same aliases with a `· <preset>` name.

## Why there is no `refreshModels`

`registerProvider` always fires `refresh({ allowNetwork: false })`, and Pi still invokes
`refreshModels` on that pass. The old callback ignored `allowNetwork` and probed the gateway
(2 s connect-refuse on Windows, ~1 s through this host's socks proxy) twice on the startup
path: once in the factory, which Pi awaits before the themed footer is installed, and again
from that refresh. The UI had already painted the stock footer, so the wait showed up as a
slow start and a chrome redraw. A written provider does not do this, and this extension is
that provider.

A Swap LLM is picked up from `/mm` (re-read config, probe, rewrite rows, write the cache).
The menu row exists only for provider ids this extension registered (`pi.events`, channels
`infer-local:providers` / `infer-local:refresh`). A direct import from `model-manager` would
be a second jiti copy and would not see this registration. A failed probe keeps the previous
rows. With no snapshot at all the provider registers with an empty model list.

## Availability trap (verified)

An extension provider without `apiKey` is **not** available: with `apiKey` removed,
`pi --list-models` answered *"No models available"*. `apiKey: "local"` is a literal dummy that
only satisfies Pi's availability check — the gateway is unauthenticated (`/v1/manifest`:
`"auth": "none"`) and ignores the resulting `Authorization: Bearer local`.

## Config

`~/.pi/agent/infer-local.json` (optional; defaults in `config.ts`):

| Key | Default | Notes |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8090/v1` | OpenAI-compatible root, no trailing slash needed |
| `providerId` | `infer` | keep it to reuse the `models.json` entry |
| `name` | `Infer local (live gateway)` | provider label in `/mm` and the selector |
| `defaultPreset` | `""` | preset pinned on the base row via `X-Infer-Preset` (e.g. `agents`). Applied only when the **stored** snapshot lists it for every chat alias; otherwise passthrough. Re-check from `/mm`. One provider, one row |
| `presets` | `[]` | extra preset rows (each = one more provider). Use only when you want a second row (e.g. `none` for stock sampling); for a single always-on preset use `defaultPreset` |
| `maxTokensCap` | `32768` | hard cap on the derived `maxTokens` |
| `contextWindowFallback` | `65536` | used only when `/v1/profiles` has no `ctx_max` |
| `compat` | qwen wire | merged over `DEFAULT_COMPAT` (`thinkingFormat: qwen-chat-template`, `supportsReasoningEffort: false`, `maxTokensField: max_tokens`) — change it if the local family is not a Qwen chat-template model |
| `thinkingLevelMap` | Qwen default (`DEFAULT_THINKING_LEVEL_MAP` in `gateway.ts`) | maps Pi thinking levels onto the `reasoning_effort` values the local templates accept; override only for a family that speaks another vocabulary |

## Refresh (`/mm`)

No slash command. Open the infer provider in `/mm`: first row **Refresh from gateway**
(`r` or Enter). That probes, re-registers (drops preset providers removed from the config),
and notifies the status line. If `infer-local` is not loaded the row is absent.

## Migration from the hand-written entries

Delete the `models` arrays of `infer` / `infer-recon` in `~/.pi/agent/models.json` (or the two
providers entirely). Their former purpose — pinning `sub-agents-handoff` / `sub-agents-recon` —
is now one config file:

```json
{ "presets": ["agents"] }
```

The name should come from the gateway's **universal** layer (`infer-gateway/config/presets.global.yaml`,
lowest precedence, valid for every alias) rather than from a card preset, which is tied to the
model it was tuned on. After a swap, refresh from `/mm` and read the notify.
