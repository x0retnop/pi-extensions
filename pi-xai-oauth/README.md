# pi-xai-oauth-fork

Форк расширения `pi-xai-oauth` (v1.2.2) с добавлением глобального переключателя on/off.

## Зачем форк

Оригинальное расширение регистрирует провайдера `xai-auth`, ~9 моделей Grok и ~19 кастомных тулзов. Проблема оригинала: **всё работает глобально**, независимо от того, какой провайдер выбран. Это ломает:

- Активный набор tools (`setActiveTools` / `getActiveTools`) через хуки `session_start`, `model_select`, `before_agent_start`.
- Cursor-shims (`Read`, `Write`, `StrReplace`, `Edit`, `Shell`, `Grep` и др.) видны всем моделям, не только Grok.
- Кастомные xAI-тулзы (`xai_web_search`, `xai_generate_image` и т.д.) тоже глобально видны, хотя при вызове из другого провайдера падают с ошибкой авторизации.

В этом форке всё исправлено: **по умолчанию расширение полностью отключено** и не вмешивается в работу других провайдеров.

---

## Как работает переключатель

- Дефолтное состояние: **`off`**.
- В `off` расширение регистрирует только CLI-команду `/xai` и больше ничего не делает.
- В `on` (после рестарта Pi) работает как оригинал: провайдер, модели, OAuth, тулзы, cursor-shims, хуки на смену модели.
- Состояние хранится в `~/.pi/agent/settings.json` под ключом `piXaiOAuthFork`.

### Команды

```
/xai on   — включить расширение (требуется рестарт Pi)
/xai off  — выключить расширение (требуется рестарт Pi)
```

### Статус в TUI

Когда включено (`on`), в статусной строке отображается `xai: on` (рядом с `role:` и прочими статусами).

---

## Структура

```
pi-xai-oauth/
├── package.json              # pi.extensions: ["./extensions/xai-oauth.ts"]
├── README.md                 # этот файл
└── extensions/
    ├── xai-oauth.ts          # точка входа: toggle + условный init
    └── xai/
        ├── auth.ts           # чтение ~/.grok/auth.json, resolveXaiAuthToken
        ├── config.ts         # loadXaiConfig / saveXaiConfig (settings.json)
        ├── constants.ts      # URL, client_id, модели, константы
        ├── images.ts         # нормализация image input
        ├── models.ts         # список моделей + роутинг CLI proxy
        ├── oauth.ts          # PKCE OAuth flow, refresh, callback server
        ├── payload.ts        # сборка request payload
        ├── responses.ts      # streamSimpleXaiResponses
        ├── text.ts           # extractResponsesText, messageFromError
        └── tools/
            ├── index.ts      # registerXaiTools (weakSet once-guard)
            ├── common.ts     # xaiToolError, xaiTextInput
            ├── cursor-args.ts # нормализация аргументов Cursor-стиля
            ├── cursor-shims.ts # регистрация 10 cursor-shim тулзов
            └── custom-tools.ts # регистрация ~9 xAI-специфичных тулзов
```

---

## Технические детали для агентов

### Точка входа: `extensions/xai-oauth.ts`

```ts
export default function (pi: ExtensionAPI) {
  pi.registerCommand("xai", { ... });  // всегда доступна

  const cfg = loadXaiConfig();
  if (cfg.enabled) {
    doInit(pi);  // регистрирует провайдера, тулзы, хуки
  }
}
```

- `doInit()` вызывается **максимум один раз** (guard через `initDone`).
- `registerCommand` работает всегда, чтобы пользователь мог включить расширение, даже если оно выключено.

### Провайдер

- ID: `xai-auth`
- Base URL: `https://api.x.ai/v1` (или `https://cli-chat-proxy.grok.com/v1` для `grok-build` / `grok-composer-2.5-fast`)
- API type: `xai-responses`
- OAuth: PKCE с callback server на `127.0.0.1:56121` (fallback на рандомный порт)
- Поддерживает reuse credentials из `~/.grok/auth.json` (официальный Grok CLI)

### Модели

| ID | Имя | Reasoning | Proxy |
|---|---|---|---|
| `grok-4.3` | Grok 4.3 | yes | no |
| `grok-build` | Grok Build | yes | **yes** |
| `grok-composer-2.5-fast` | Composer 2.5 Fast | no | **yes** |
| `grok-4.20-0309-reasoning` | Grok 4.20 Reasoning | yes | no |
| `grok-4.20-0309-non-reasoning` | Grok 4.20 Non-Reasoning | no | no |
| `grok-4.20-multi-agent-0309` | Grok 4.20 Multi-Agent | yes | no |

### Тулзы

**Cursor-shims** (10 шт): `Read`, `Write`, `StrReplace`, `Edit`, `Delete`, `LS`, `Grep`, `Glob`, `Shell`, `WebSearch`.

**xAI-специфичные** (~9 шт): `xai_generate_text`, `xai_multi_agent`, `xai_web_search`, `xai_x_search`, `xai_code_execution`, `xai_generate_image`, `xai_critique`, `xai_analyze_image`, `xai_deep_research`.

Все они регистрируются только в режиме `on`.

### Хуки

В режиме `on` подписывается на 3 события:
- `session_start` → `syncCursorToolShimsForModel()` + `ui.setStatus("xai", "xai: on")`
- `model_select` → `syncCursorToolShimsForModel()`
- `before_agent_start` → `syncCursorToolShimsForModel()` + `ui.setStatus("xai", "xai: on")`

`syncCursorToolShimsForModel` проверяет `model?.provider === XAI_PROVIDER_ID && isGrokCliProxyModel(model.id)` и добавляет/убирает cursor-shims из `activeTools`. При работе с другими провайдерами shims убирает, но сам факт перезаписи `setActiveTools` может конфликтовать с другими расширениями — это поведение оригинала, в форке не исправлено (только изолируется через toggle).

---

## Установка / обновление

1. Скопировать папку `pi-xai-oauth` из `C:/10x001/pi extensions/` в `C:/Users/user/.pi/agent/extensions/`.
2. Перезапустить Pi.
3. По умолчанию расширение **выключено**.
4. Включить: `/xai on`, затем перезапустить Pi.

## Зависимости

- `@earendil-works/pi-ai` (peer)
- `@earendil-works/pi-coding-agent` (peer)
- Встроенные Node.js модули: `crypto`, `http`, `fs`, `os`, `path`

Никаких npm-зависимостей устанавливать не нужно.
