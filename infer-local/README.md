# infer-local

Stand-in for a hand-written `infer` provider in `models.json`. On load it registers the last
stored gateway snapshot and then sits still — no startup probe, no catalog refresh, no
slash command. After a Swap LLM, open `/mm` → the infer provider → **Refresh from gateway**.

## Install

Copy the compiled folder from `_build/extensions/` to `~/.pi/agent/extensions/` and restart Pi.
Then delete the hardcoded local `models` arrays from `~/.pi/agent/models.json` (the extension
replaces them anyway) — keep the provider entry only if you want to override `baseUrl`/`compat`.

## Config (`~/.pi/agent/infer-local.json`, optional)

```json
{
  "baseUrl": "http://127.0.0.1:8090/v1",
  "providerId": "infer",
  "defaultPreset": "agents",
  "presets": []
}
```

`defaultPreset` pins that gateway preset on the **base** row via `X-Infer-Preset`, so the
single local row always runs with it (recommended: a name from the gateway's universal layer,
`infer-gateway/config/presets.global.yaml`). The pin is taken from the stored snapshot: if that
snapshot does not list the name, the row stays passthrough instead of 400ing. Re-check from
`/mm` → Refresh from gateway. Empty = no header.

`presets` is a whitelist of gateway preset names; each becomes an extra provider pinned with
the `X-Infer-Preset` header (`agents` -> provider `infer-agents`). Empty/absent = the bare live
model only. Prefer a name from the gateway's universal layer (`infer-gateway/config/presets.global.yaml`,
e.g. `agents`): it exists for every alias, so the row survives a model swap, unlike card presets
which are per-model. A refresh notify includes the stored alias and whether the pin is in
that snapshot.
Other keys: `name`, `maxTokensCap`, `contextWindowFallback`, `compat`.

## Refresh

No slash command. In `/mm`, open the infer provider: the first row is **Refresh from gateway**
(`r` or Enter). That is the only gateway probe, and it rewrites the rows. The notify is the
status line (alias, pin, last error).

## Behavior notes

- Context window and capabilities come from `GET /v1/profiles`, preset names from
  `GET /v1/presets`; only chat aliases become rows.
- Startup never contacts the gateway. Rows come from `infer-local-cache.json`. A dead gateway
  only matters when you run `refresh` or `presets`.
- `maxTokens` is capped at `ctx/4` (≤32768) because the gateway rejects
  `input + max_tokens > ctx_max` with a loud 400.
