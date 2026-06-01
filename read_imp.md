Нужен **mode-based read** — один тул, который умеет возвращать не «сырой текст», а «то, что агенту нужно для принятия решения», минимальным числом вызовов.

---

## Концепция: `read` с режимами

Вместо того чтобы агент тыкал в файл вслепую, он один раз запрашивает **карту** (структуру), а потом точечно читает **секции**. Это 2 вызова вместо 5-10.

### Параметры тулла

```typescript
{
  path: string,           // путь к файлу
  mode: "overview" | "section" | "grep" | "headtail" | "raw",
  target?: string,        // для section: имя функции/класса
                         // для grep: regex или строка для поиска
  contextLines?: number,  // ±N строк вокруг match (для grep/section)
  maxBytes?: number,     // жесткий лимит (default ~8KB)
  budgetTokens?: number  // мягкий лимит: "у меня осталось 1500 токенов"
}
```

---

## Режимы и сценарии использования

### 1. `mode: "overview"` — карта файла
**Что возвращает:** структура файла с номерами строк, без тел функций.

```text
📄 src/services/user.ts (340 lines, 12KB)
├─ import { ... } from "..."          [1-3]
├─ interface UserConfig               [5-9]
├─ class UserService                  [11-156]
│  ├─ constructor()                   [13-19]
│  ├─ authenticate()                  [21-45]
│  ├─ validateToken()                 [47-62]
│  └─ refreshSession()                [64-89]
├─ helper parseJWT()                  [158-174]
└─ export default ...                 [176]
```

**Зачем:** агент видит, где что лежит, и следующим вызовом читает **только** `authenticate()` через `mode:section`.

**Токен-эффективность:** ~50-150 токенов вместо 3000+ на чтение всего файла.

---

### 2. `mode: "section"` — чтение по имени
**Что делает:** ищет в файле границы секции (функция/класс/метод) и возвращает только её.

```typescript
// Агент вызывает:
read({ path: "src/services/user.ts", mode: "section", target: "authenticate" })

// Получает:
[lines 21-45] function authenticate(credentials: AuthPayload): Promise<<AuthResult> {
  ...тело функции...
}
```

**Как находить границы:** regex-based парсер (без AST-зависимостей):
- **Python**: `def ` / `class ` + отступы (следующий блок с меньшим/равным отступом = конец)
- **JS/TS**: `function` / `const fn =` / `class` / `methodName(` + следующая декларация того же уровня или закрывающая скобка файла
- **Markdown**: заголовок `#` до следующего `#` того же или вышележащего уровня
- **JSON**: ключ верхнего уровня + его value (брекетный счётчик)

**Почему это критично:** агент не тратит токены на чтение 300 строк ради одной функции.

---

### 3. `mode: "grep"` — поиск внутри файла с контекстом
**Объединяет `grep` + `read` в один вызов.**

```typescript
read({ 
  path: "src/services/user.ts", 
  mode: "grep", 
  target: "validateToken",
  contextLines: 3 
})
```

**Возвращает:** все строки, где встречается `validateToken`, ±3 строки вокруг каждого match. Если match один — это фактически `section` без точного знания границ.

**Зачем:** когда агент помнит, что в файле есть `validateToken`, но не знает, в какой функции.

---

### 4. `mode: "headtail"` — для логов и конфигов
**Что возвращает:** первые N строк + последние N строк + срез по середине (если запросили).

```text
[Head: lines 1-20]
...начало лога...

[... skipped 14,230 lines ...]

[Tail: lines 14,251-14,270]
...конец лога...
```

**Дополнительно:** если агент указал `target: "ERROR"`, можно вернуть head + все строки с ERROR + tail.

---

### 5. `mode: "raw"` — классическое чтение
Для маленьких файлов (< лимита) — обычное поведение. Для больших — head + сообщение «используй overview/section».

---

## Почему это экономит токены

| Сценарий | Классический read | Mode-based read |
|---|---|---|
| Найти функцию в 500-строчном файле | 5 вызовов × 100 строк = 500 строк в истории + 5 tool results | 1 overview (20 строк) + 1 section (40 строк) = 60 строк + 2 results |
| Проверить, где импортится `lodash` | grep + read = 2 вызова | 1 grep-mode = 1 вызов |
| Понять структуру нового модуля | Читать вслепую или cat в bash | 1 overview |

**Каждый лишний tool result** в истории сессии — это ~50-100 токенов на overhead (tool_call_id, название, аргументы). При 10 вызовах это +1000 токенов «пустого» веса.

---

## Примерный план реализации

### Шаг 1. Переопредели built-in `read`
```typescript
pi.registerTool({
  name: "read", // override built-in
  parameters: Type.Object({
    path: Type.String(),
    mode: StringEnum(["overview", "section", "grep", "headtail", "raw"]),
    target: Type.Optional(Type.String()),
    contextLines: Type.Optional(Type.Number({ default: 3 })),
    maxBytes: Type.Optional(Type.Number({ default: 8192 })),
  }),
  promptGuidelines: [
    "Use read with mode:overview first for large files to see structure, then mode:section to read specific functions.",
    "Use mode:grep to search inside a file instead of bash grep when you need context.",
    "Never use mode:raw on files larger than 200 lines; use overview + section instead."
  ],
  // ...
})
```

### Шаг 2. Легковесный парсер структуры (без AST-зависимостей)
В `execute` при `mode:overview`:
1. Прочитать файл целиком (в память, не в контекст)
2. Построчный regex-scan:
   - `/^\s*(export\s+)?(class|interface|function|const|let|var)\s+(\w+)/`
   - `/^\s*(def|class)\s+(\w+)/` (Python)
   - `/^(#{1,6})\s+(.+)/` (Markdown)
3. Построить массив `{ name, type, startLine, endLine }`
4. Вернуть только таблицу (не код)

**Кэш:** сохранить эту карту в `Map<string, Structure>` внутри extension на уровне сессии. Повторный `overview` того же файла — мгновенно, без диска.

### Шаг 3. Реализация `section`
1. Взять карту из кэша (или построить, если нет)
2. Найти `target` (fuzzy match: `authenticate` найдёт `authenticate`, `async authenticate`, `private authenticate`)
3. `startLine` из карты, `endLine` = `min(nextSibling.startLine - 1, fileEnd)`
4. Вернуть slice с `[lines X-Y]` в заголовке

### Шаг 4. Реализация `grep`
1. Прочитать файл, найти все строки с `target`
2. Для каждого match взять `±contextLines`
3. Смержить overlapping ranges
4. Вернуть с маркерами `[match at line 45]`

### Шаг 5. Truncation и бюджет
Все режимы перед возвратом прогонять через `truncateHead` с `maxBytes: 8192` (~1600 токенов). Если не влезает — добавлять в конец:
```text
[Truncated: showing 45 of 120 lines. Use mode:section target:"nextFunction" to continue.]
```

---

## Дополнительные фишки (по желанию)

### `budgetTokens`
Если агент передаёт `budgetTokens: 800`, тул считает примерно `lines ≈ tokens / 4` и возвращает столько строк, сколько влезает. Это позволяет агенту явно управлять расходом контекста.

### Автоматический `overview` для больших файлов
Если агент вызвал `mode:raw` на файле >200 строк, тул автоматически возвращает `overview` вместо сырого текста с сообщением:
```text
[File is 500 lines. Use mode:section with a target from the overview below.]
```

### Кэш структуры между вызовами
```typescript
const structureCache = new Map<string, { mtime: number, structure: Section[] }>();

// При чтении проверять mtime файла, если не изменился — брать из кэша
```

---

## Итоговая архитектура для твоего агента

```
Агент хочет разобраться в файле:
  ↓
read({ path: "foo.ts", mode: "overview" })
  → получает карту за 100 токенов
  ↓
read({ path: "foo.ts", mode: "section", target: "handleRequest" })
  → получает тело функции за 300 токенов
  ↓
Готово. 2 вызова, 2 результата в истории.
```

Вместо классического:
```
read foo.ts (lines 1-100)
read foo.ts (lines 101-200)  
read foo.ts (lines 201-300)
...5 вызовов, 5 результатов, агент всё ещё не знает, где handleRequest
```
