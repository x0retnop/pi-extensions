# Kimi For Coding в Pi CLI

Конспект для агентов, основанный на инспекции Pi CLI v0.79.0.

## Встроенный провайдер `kimi-coding`

- Внутренний ID: `kimi-coding`
- Отображаемое имя: `Kimi For Coding`
- `auth.json` key: `kimi-coding`
- Env key: `KIMI_API_KEY`
- Путь в пакете Pi: `node_modules/@earendil-works/pi-ai/dist/models.generated.js`

### Модели

```json
{
  "kimi-for-coding": {
    "id": "kimi-for-coding",
    "name": "Kimi For Coding",
    "api": "anthropic-messages",
    "provider": "kimi-coding",
    "baseUrl": "https://api.kimi.com/coding",
    "headers": { "User-Agent": "KimiCLI/1.5" },
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 262144,
    "maxTokens": 32768
  },
  "kimi-k2-thinking": {
    "id": "kimi-k2-thinking",
    "name": "Kimi K2 Thinking",
    "api": "anthropic-messages",
    "provider": "kimi-coding",
    "baseUrl": "https://api.kimi.com/coding",
    "headers": { "User-Agent": "KimiCLI/1.5" },
    "reasoning": true,
    "input": ["text"],
    "contextWindow": 262144,
    "maxTokens": 32768
  }
}
```

Различия между моделями:
- `kimi-for-coding` поддерживает текст + изображения (`["text", "image"]`)
- `kimi-k2-thinking` — только текст (`["text"]`)
- Остальные параметры идентичны

### API-формат

- API: `anthropic-messages`
- Endpoint: `https://api.kimi.com/coding` (без `/v1`)
- Используется официальный Anthropic SDK (`pi-ai/dist/providers/anthropic.js`)
- Запрос строится как стандартный Anthropic Messages API: `model`, `messages`, `max_tokens`, `stream`, `system`, `tools`, `thinking`
- Авторизация: `x-api-key` от Anthropic SDK

### Аутентификация

Приоритет получения ключа (`dist/core/auth-storage.js`):
1. CLI `--api-key`
2. `auth.json` → `"kimi-coding": { "type": "api_key", "key": "..." }`
3. Env `KIMI_API_KEY`
4. Fallback из `models.json`

`/login` → «Use an API key» → `Kimi For Coding` → сохраняет ключ в `auth.json`.

### Отличие от кастомного `kimi` в `models.json`

В текущем `~/.pi/agent/models.json` уже есть отдельный провайдер `kimi`, настроенный как OpenAI Completions API:

- `baseUrl`: `https://api.kimi.com/coding/v1`
- `api`: `openai-completions`
- `headers`: `{ "User-Agent": "opencode/1.17.1" }`
- `thinkingFormat`: `"zai"`
- `compat.maxTokensField`: `"max_tokens"`

Это альтернативный способ работы с Kimi, не связанный со встроенным `kimi-coding`. Оба варианта могут сосуществовать.

## Пример кастомного провайдера в `models.json`

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

## Полезные ключи поиска в Pi

- Встроенные модели: `node_modules/@earendil-works/pi-ai/dist/models.generated.js`
- Провайдер Anthropic: `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js`
- Регистрация API-провайдеров: `node_modules/@earendil-works/pi-ai/dist/providers/register-builtins.js`
- Env-переменные: `node_modules/@earendil-works/pi-ai/dist/env-api-keys.js`
- Хранение ключей: `dist/core/auth-storage.js`
- `/login` TUI: `dist/modes/interactive/interactive-mode.js`
- Имена провайдеров: `dist/core/provider-display-names.js`
- Резолвинг моделей: `dist/core/model-resolver.js`
