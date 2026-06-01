# Pi CLI — Провайдеры и модели

Конспект для агентов по работе с LLM-провайдерами в Pi CLI. Основан на исходниках Pi v0.78 и опыте настройки.

## Кратко

- Список моделей в `/model` **статический** — Pi **не запрашивает** `/v1/models` у провайдеров при старте.
- Модели берутся из двух источников: `models.generated.js` (встроенные, зашиты в бинарь) + `models.json` (кастомные/оверрайды).
- Фильтрация "доступных" (`getAvailable()`) — только по наличию ключа в `auth.json` / env.

## Ключевые файлы

| Файл | Назначение |
|---|---|
| `~/.pi/agent/models.json` | Кастомные провайдеры, модели, оверрайды |
| `~/.pi/agent/auth.json` | API ключи и OAuth токены |
| `~/.pi/agent/settings.json` | Глобальные настройки (defaultProvider, defaultModel и т.д.) |
| `models.generated.js` внутри `@earendil-works/pi-ai` | Встроенный статический список моделей и провайдеров |

Шипнутые доки Pi: `providers.md`, `models.md` внутри `pi-coding-agent/docs/`.

## Как модели попадают в `/model`

```
loadModels()
  ├── loadCustomModels(models.json)     // кастомные + оверрайды
  ├── loadBuiltInModels()               // статика из models.generated.js
  ├── mergeCustomModels()               // custom > built-in (upsert by provider+id)
  └── getAvailable()                    // фильтр: есть ли ключ?
```

- **Встроенные модели** обновляются только с релизом Pi CLI. Новая модель у Zen/Go не появится в `/model`, пока не выйдет новая версия Pi.
- **Кастомные модели** из `models.json` сразу видны после сохранения файла (reload при открытии `/model`).

## Как прописать ключ (auth)

Варианты по приоритету (выше — важнее):

1. CLI флаг `--api-key`
2. `~/.pi/agent/auth.json`
3. Environment variable (`OPENCODE_API_KEY`, `OPENROUTER_API_KEY` и т.д.)
4. `apiKey` прямо в `models.json` (не рекомендуется — ключ в файле)

Пример `auth.json`:
```json
{
  "opencode": { "type": "api_key", "key": "sk-..." },
  "opencode-go": { "type": "api_key", "key": "sk-..." },
  "openrouter": { "type": "api_key", "key": "sk-..." }
}
```

Поддерживаются команды (`!...`), env-интерполяция (`$VAR`), литералы. См. `providers.md` раздел "Key Resolution".

## Встроенные провайдеры OpenCode / MiniMax

| Провайдер | Что это | Ключ в `auth.json` | Env |
|---|---|---|---|
| `opencode` | **Zen free tier** | `opencode` | `OPENCODE_API_KEY` |
| `opencode-go` | **Go paid tier** | `opencode-go` | `OPENCODE_API_KEY` |
| `openrouter` | Агрегатор моделей | `openrouter` | `OPENROUTER_API_KEY` |
| `minimax` | Прямой API MiniMax | `minimax` | `MINIMAX_API_KEY` |

**Важно:** ключи `opencode` и `opencode-go` могут быть одинаковыми (подписка Go даёт доступ и к free endpoint). Проверяйте `curl`.

Free-модели Zen (уже встроены в Pi v0.78):
- `deepseek-v4-flash-free`
- `mimo-v2.5-free`
- `qwen3.6-plus-free`
- `big-pickle`
- `glm-4.7-free`
- `nemotron-3-super-free`

`minimax-m3-free` — пока **не встроена**, добавляйте вручную через `models.json`.

## Добавление модели во встроенный провайдер

Если модели нет в `models.generated.js`, допишите её в `models.json` под именем существующего провайдера. Pi смержит массив `models` со встроенным списком.

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

Модель появится в `/model` сразу, если есть ключ `opencode` в `auth.json`.

## Кастомный провайдер (полностью новый)

Для провайдера, которого нет в Pi:

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

Обязательно для нового провайдера: `baseUrl`, `apiKey` (или `authHeader: true` + ключ в `auth.json`), `api`, `models`.

## Ловушка: thinkingFormat

Поле `compat.thinkingFormat` влияет **только на то, как Pi шлёт thinking-контрол в запрос** и парсит ответ. Не все провайдеры понимают все форматы.

| Формат | Что шлёт Pi в запрос | Опасности |
|---|---|---|
| `deepseek` | `thinking: { type: "enabled" }` + `reasoning_effort` | MiniMax M3 отвергает `enabled`, ожидает `adaptive`/`disabled`. |
| `openrouter` | `reasoning: { effort }` | Работает только для OpenRouter. |
| `together` | `reasoning: { enabled }` | Together AI. |
| `qwen` / `qwen-chat-template` | `enable_thinking` | Qwen. |

**Практика:** если модель сама решает, когда reasoning'овать (как M3), оставьте `reasoning: true`, но **не указывайте `thinkingFormat`**. Pi не будет слать thinking-контрол, но `<think>`…`</think>` в ответе распарсит как thinking blocks.

## Отладка: curl перед правкой `models.json`

Всегда проверяйте endpoint руками перед добавлением модели в Pi:

```bash
# Список моделей
 curl -s -H "Authorization: Bearer $KEY" https://opencode.ai/zen/v1/models

# Тестовый запрос
 curl -s https://opencode.ai/zen/v1/chat/completions \
   -H "Authorization: Bearer $KEY" \
   -H "Content-Type: application/json" \
   -d '{"model":"minimax-m3-free","messages":[{"role":"user","content":"hi"}],"max_tokens":50}'
```

Это сэкономит время на перезапуски Pi.

## OpenRouter free модели

На OpenRouter добавьте суффикс `:free` к ID модели:
- `minimax/minimax-m2.5:free`
- `meta-llama/llama-3.2-3b-instruct:free`

OpenRouter — встроенный провайдер Pi. Достаточно ключа `OPENROUTER_API_KEY`.

## Полезные ссылки

- Официальные доки Pi (шипнутые в `pi-coding-agent/docs/`):
  - `providers.md` — все встроенные провайдеры, env-переменные, auth file.
  - `models.md` — формат `models.json`, merge semantics, compat-поля.
- `models.generated.js` — смотрите grep'ом, какие модели уже встроены.
- `pi-local-map.md` — где на диске лежат типы и исходники Pi.