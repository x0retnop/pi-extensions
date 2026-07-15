# Kimi For Coding in Pi CLI

Agent guide, based on Pi CLI source inspection (originally v0.79.0, model list verified against 0.80.7).

## Built-in `kimi-coding` provider

- Internal ID: `kimi-coding`
- Display name: `Kimi For Coding`
- `auth.json` key: `kimi-coding`
- Env key: `KIMI_API_KEY`
- Location in the Pi package: `pi-ai/dist/providers/kimi-coding.models.js`

### Models (0.80.7)

| ID | Input | Notes |
|---|---|---|
| `k2p7` | text + image | Newest; added after 0.79.x |
| `kimi-for-coding` | text + image | |
| `kimi-k2-thinking` | text only | |

All three: `api: anthropic-messages`, `baseUrl: https://api.kimi.com/coding` (no `/v1`), `reasoning: true`, `contextWindow: 262144`, `maxTokens: 32768`, header `User-Agent: KimiCLI/1.5`.

### API format

- API: `anthropic-messages`
- Uses the official Anthropic SDK (`pi-ai/dist/providers/anthropic.js`)
- Request is standard Anthropic Messages API: `model`, `messages`, `max_tokens`, `stream`, `system`, `tools`, `thinking`
- Auth: `x-api-key` via the Anthropic SDK

### Authentication

Key resolution priority (`dist/core/auth-storage.js`):
1. CLI `--api-key`
2. `auth.json` → `"kimi-coding": { "type": "api_key", "key": "..." }`
3. Env `KIMI_API_KEY`
4. Fallback from `models.json`

`/login` → "Use an API key" → `Kimi For Coding` saves the key to `auth.json`.

### Difference from the custom `kimi` in `models.json`

The current `~/.pi/agent/models.json` also has a separate `kimi` provider configured as OpenAI Completions API:

- `baseUrl`: `https://api.kimi.com/coding/v1`
- `api`: `openai-completions`
- `headers`: `{ "User-Agent": "opencode/1.17.1" }`
- `thinkingFormat`: `"zai"`
- `compat.maxTokensField`: `"max_tokens"`

This is an alternative way to talk to Kimi, unrelated to the built-in `kimi-coding`. Both variants can coexist.

## Example custom provider in `models.json`

```json
{
  "providers": {
    "kimi-builtin": {
      "name": "Kimi Coding (built-in style)",
      "baseUrl": "https://api.kimi.com/coding",
      "api": "anthropic-messages",
      "apiKey": "$KIMI_API_KEY",
      "headers": { "User-Agent": "KimiCLI/1.5" },
      "models": [
        {
          "id": "kimi-for-coding",
          "name": "Kimi For Coding",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 262144,
          "maxTokens": 32768
        }
      ],
      "defaultModel": "kimi-for-coding"
    }
  }
}
```

## Useful search keys in Pi

- Built-in models: `pi-ai/dist/models.generated.js` (+ `pi-ai/dist/providers/kimi-coding.models.js`)
- Anthropic provider: `pi-ai/dist/providers/anthropic.js`
- API provider registration: `pi-ai/dist/providers/register-builtins.js`
- Env variables: `pi-ai/dist/env-api-keys.js`
- Key storage: `dist/core/auth-storage.js`
- `/login` TUI: `dist/modes/interactive/interactive-mode.js`
- Provider display names: `dist/core/provider-display-names.js`
- Model resolution: `dist/core/model-resolver.js`
