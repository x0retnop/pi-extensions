# Доработка API: безопасное чтение содержимого сессии

## Проблема

Сейчас `GET /api/session_index/search` возвращает `source_path` — абсолютный путь к `.jsonl` файлу. Внешний агент (Pi extension) читает этот файл локально через `fs.readFile`. Файлы сессий могут весить десятки мегабайт. Если агент решит прочитать такой файл целиком — контекстное окно мгновенно переполняется, или сервер отключает соединение.

Нужен **server-side** endpoint, который безопасно отдаёт содержимое сессии с жёсткими лимитами, избавляя клиента от парсинга JSONL и ручного контроля бюджета.

## Предлагаемое решение

Добавить endpoint:

```
POST /api/session_index/session_content
```

### Request body

```json
{
  "source_path": "C:/Users/user/.pi/agent/sessions/--C--ai_db--/2026-05-27T16-45-08-936Z_....jsonl",
  "max_messages": 30,
  "max_chars": 4000,
  "skip_thinking": true,
  "tool_result_limit": 200
}
```

| Поле | Тип | Default | Описание |
|------|-----|---------|----------|
| `source_path` | string | обязательно | Абсолютный путь к `.jsonl` |
| `max_messages` | int | 30 | Сколько последних сообщений взять |
| `max_chars` | int | 4000 | Жёсткий лимит на длину `text` |
| `skip_thinking` | bool | true | Пропускать блоки `type: thinking` |
| `tool_result_limit` | int | 200 | Обрезать `toolResult` до N символов |

### Response body

```json
{
  "source_path": "C:/Users/user/.../session.jsonl",
  "project": "ai_db",
  "date": "2026-05-27T16:45:08",
  "total_messages": 124,
  "returned_messages": 30,
  "chars": 3872,
  "truncated": false,
  "text": "[User] как настроить векторный поиск?\n\n[Assistant] Use sqlite-vec...\n\n[ToolResult] file: vector_memory.py content: ..."
}
```

| Поле | Описание |
|------|----------|
| `total_messages` | Сколько всего сообщений в сессии |
| `returned_messages` | Сколько вошло в ответ (после `max_messages`) |
| `chars` | Длина `text` |
| `truncated` | Был ли `text` обрезан по `max_chars` |
| `text` | Отформатированный текст. Формат: `[User] ...`, `[Assistant] ...`, `[ToolResult] ...` |

### Форматирование `text`

Сервер сам парсит JSONL и форматирует:

- `role: user` → `[User] {content}`
- `role: assistant` → `[Assistant] {content}` (без `thinking` блоков, если `skip_thinking: true`)
- `role: toolResult` → `[ToolResult] {content}` (обрезано до `tool_result_limit`)
- `model_change`, `thinking_level_change`, `custom_message` с `display: false` → пропускаются

### Алгоритм обрезки по `max_chars`

1. Берём последние `max_messages` сообщений.
2. Склеиваем через `\n\n`.
3. Если длина > `max_chars`:
   - Пока длина > `max_chars` и сообщений > 1 — убираем самое старое сообщение.
   - Если осталось 1 сообщение и оно всё ещё > `max_chars` — обрезаем хвост, добавляя префикс `...[truncated]\n\n`.

### Error codes

| Код | Ситуация |
|-----|----------|
| 400 | `source_path` не указан, или сессия не найдена, или путь вне `SESSION_INDEX_ROOT` |
| 400 | `SESSION_INDEX_ENABLED=false` |
| 503 | Backend not ready |

## Почему это лучше, чем клиент читает файл сам

- **Безопасность:** клиент не может случайно прочитать 50 МБ.
- **Единый формат:** сервер знает структуру `.jsonl` и может корректно фильтровать `thinking`, `custom_message`, `toolResult`.
- **Проще клиент:** TypeScript-расширению не нужен парсер JSONL и логика обрезки.
- **Миграция:** после появления этого endpoint Pi extension заменит `fs.readFile` на один HTTP-вызов, ничего больше не меняя.
