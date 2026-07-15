# Pi CLI — Providers and Models

Agent guide to LLM providers in Pi CLI. Based on Pi source (originally v0.78, spot-checked through 0.80.7) and hands-on setup experience.

## In short

- The `/model` list is **static** — Pi does **not** query `/v1/models` from providers at startup.
- Models come from two sources: `models.generated.js` (built-in, compiled into the package) + `models.json` (custom/overrides).
- "Available" filtering (`getAvailable()`) is only by key presence in `auth.json` / env.

## Key files

| File | Purpose |
|---|---|
| `~/.pi/agent/models.json` | Custom providers, models, overrides |
| `~/.pi/agent/auth.json` | API keys and OAuth tokens |
| `~/.pi/agent/settings.json` | Global settings (defaultProvider, defaultModel, etc.) |
| `models.generated.js` inside `@earendil-works/pi-ai` | Built-in static provider/model list |

Shipped Pi docs: `providers.md`, `models.md` inside `pi-coding-agent/docs/` (see `docs/pi-local-map.md`).

## How models get into `/model`

```
loadModels()
  ├── loadCustomModels(models.json)     // custom + overrides
  ├── loadBuiltInModels()               // static from models.generated.js
  ├── mergeCustomModels()               // custom > built-in (upsert by provider+id)
  └── getAvailable()                    // filter: is there a key?
```

- **Built-in models** update only with a Pi CLI release. A new model on the provider side does not appear in `/model` until Pi ships it — add it manually via `models.json` meanwhile.
- **Custom models** from `models.json` are visible immediately after saving (reload when `/model` opens).

## How to configure a key (auth)

Options by priority (highest first):

1. CLI flag `--api-key`
2. `~/.pi/agent/auth.json`
3. Environment variable (`OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, ...)
4. `apiKey` directly in `models.json` (not recommended — key on disk)

Example `auth.json`:
```json
{
  "opencode": { "type": "api_key", "key": "sk-..." },
  "opencode-go": { "type": "api_key", "key": "sk-..." },
  "openrouter": { "type": "api_key", "key": "sk-..." }
}
```

Commands (`!...`), env interpolation (`$VAR`), and literals are supported. See shipped `providers.md`, section "Key Resolution".

## Built-in OpenCode / MiniMax / OpenRouter providers

| Provider | What it is | `auth.json` key | Env |
|---|---|---|---|
| `opencode` | **Zen free tier** | `opencode` | `OPENCODE_API_KEY` |
| `opencode-go` | **Go paid tier** | `opencode-go` | `OPENCODE_API_KEY` |
| `openrouter` | Model aggregator | `openrouter` | `OPENROUTER_API_KEY` |
| `minimax` | Direct MiniMax API | `minimax` | `MINIMAX_API_KEY` |

**Note:** `opencode` and `opencode-go` keys can be identical (a Go subscription also grants access to the free endpoint). Verify with `curl`.

To see which models are currently built in (including free-tier ones), grep `models.generated.js` — the list changes with every Pi release, so it is not mirrored here.

## Adding a model to a built-in provider

If a model is missing from `models.generated.js`, add it in `models.json` under the existing provider name. Pi merges the `models` array with the built-in list.

```json
{
  "providers": {
    "opencode": {
      "models": [
        {
          "id": "minimax-m3-free",
          "name": "MiniMax M3 Free",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

The model appears in `/model` immediately if an `opencode` key exists in `auth.json`.

## Fully custom provider

For a provider Pi does not know:

```json
{
  "providers": {
    "my-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_PROXY_KEY",
      "models": [
        { "id": "gpt-4", "name": "GPT-4 via proxy", "reasoning": true }
      ]
    }
  }
}
```

Required for a new provider: `baseUrl`, `apiKey` (or `authHeader: true` + key in `auth.json`), `api`, `models`.

## Trap: thinkingFormat

The `compat.thinkingFormat` field affects **only how Pi sends the thinking control in the request** and parses the response. Not all providers understand all formats.

| Format | What Pi sends | Dangers |
|---|---|---|
| `deepseek` | `thinking: { type: "enabled" }` + `reasoning_effort` | MiniMax M3 rejects `enabled`, expects `adaptive`/`disabled`. |
| `openrouter` | `reasoning: { effort }` | Only works for OpenRouter. |
| `together` | `reasoning: { enabled }` | Together AI. |
| `qwen` / `qwen-chat-template` | `enable_thinking` | Qwen. |

**Practice:** if the model decides on its own when to reason (like M3), keep `reasoning: true` but **do not set `thinkingFormat`**. Pi will not send a thinking control, but `<think>...</think>` in the response is still parsed as thinking blocks.

## Debugging: curl before editing `models.json`

Always check the endpoint manually before adding a model to Pi:

```bash
# Model list
curl -s -H "Authorization: Bearer $KEY" https://opencode.ai/zen/v1/models

# Test request
curl -s https://opencode.ai/zen/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"minimax-m3-free","messages":[{"role":"user","content":"hi"}],"max_tokens":50}'
```

This saves time on Pi restarts.

## OpenRouter free models

On OpenRouter, add the `:free` suffix to the model ID, e.g. `minimax/minimax-m2.5:free`. OpenRouter is a built-in Pi provider — an `OPENROUTER_API_KEY` is enough.

## Useful links

- Shipped Pi docs (inside `pi-coding-agent/docs/`):
  - `providers.md` — all built-in providers, env variables, auth file.
  - `models.md` — `models.json` format, merge semantics, compat fields.
- `models.generated.js` — grep it to see what is built in.
- `docs/pi-local-map.md` — where Pi's types and sources live on disk.
