## Pi + Markdown: Pro Tips для агента (только релевантное)

### 1. pi-tool-codex делает цвета, но НЕ скрывает символы

`assistant-message-style.ts` из pi-tool-codex патчит `AssistantMessageComponent.prototype` и навешивает **цветовую тему** на markdown-элементы:

```typescript
heading: (text) => `\x1b[38;2;255;255;255m${text}\x1b[39m`   // белый
code:    (text) => `\x1b[38;2;58;150;221m${text}\x1b[39m`   // синий
listBullet: (text) => `\x1b[38;2;58;150;221m${text}\x1b[39m`
```

**Но:** `pi-tui` рендерит markdown как **styled source** — `#`, `` ` ``, `**`, `-` остаются видимыми, просто раскрашиваются. `MarkdownTheme` получает уже очищенный `text` (без `#`), а сам парсер рисует символы разметки отдельно. Тема не контролирует их отображение.

**Вывод:** чтобы скрыть `#` и `` ` ``, нужен **post-processing строк после рендеринга**, а не `MarkdownTheme`.

---

### 2. Правильный паттерн патча (из pi-tool-codex)

Всегда сохраняй оригинал и версионируй. Иначе `/reload` создаёт бесконечную вложенность.

```typescript
const PATCH_VERSION = 1;

interface Patchable {
  render?: (width: number) => string[];
  __myOriginalRender?: (width: number) => string[];
  __myPatchVersion?: number;
}

function patchRender(proto: Patchable, transform: (lines: string[]) => string[]): void {
  // Idempotency: не патчить дважды
  if (proto.__myPatchVersion === PATCH_VERSION) return;

  if (!proto.__myOriginalRender && proto.render) {
    proto.__myOriginalRender = proto.render;
  }
  const orig = proto.__myOriginalRender;
  if (!orig) return;

  proto.render = function (width: number): string[] {
    const lines = orig.call(this, width);
    return transform(lines);
  };
  proto.__myPatchVersion = PATCH_VERSION;
}
```

**Где применять:**
```typescript
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

const proto = (AssistantMessageComponent as any).prototype;
patchRender(proto, cleanMarkdownSymbols);

// 🔁 Перепатчивание после /reload
pi.on("before_agent_start", async () => {
  patchRender((AssistantMessageComponent as any).prototype, cleanMarkdownSymbols);
});
```

---

### 3. Post-processing: что и как стрипать

`render(width)` возвращает `string[]` — массив строк с ANSI escape sequences. Нужно чистить символы, **сохраняя ANSI-цвета**.

```typescript
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function cleanMarkdownSymbols(lines: string[]): string[] {
  return lines.map((line) => {
    // Получаем «чистый» текст без ANSI для проверки паттернов
    const plain = line.replace(ANSI_PATTERN, "");

    // 1. Заголовки: "# Title" → "  Title" (пробелы вместо #, сохраняем отступ)
    if (/^#{1,6}\s+/.test(plain)) {
      const hashes = plain.match(/^(#{1,6})/)?.[0]?.length ?? 0;
      line = line.replace(/#{1,6}\s+/, " ".repeat(hashes) + "  ");
    }

    // 2. Code block fences: "```ts" или "```" → пустая строка (граница блока)
    if (/^\s*```\w*\s*$/.test(plain)) {
      return "";
    }

    // 3. Inline code: `text` → text (убираем backticks, содержимое с ANSI остаётся)
    line = line.replace(/`([^`]+)`/g, "$1");

    // 4. Bold: **text** → text
    line = line.replace(/\*\*([^*]+)\*\*/g, "$1");

    // 5. Italic: *text* → text (не трогаем уже очищенное от **)
    line = line.replace(/(?<<!\*)\*([^*]+)\*(?!\*)/g, "$1");

    // 6. List bullets в начале: "  - item" → "    item"
    line = line.replace(/^(\s*)[-*+]\s+/, (_, indent) => indent + "  ");

    return line;
  });
}
```

**Важно:** `replace` работает на строке **с ANSI**. Если ANSI-коды оборачивают символы разметки (например, `\x1b[36m#\x1b[0m Title`), regex всё равно найдёт `#`, потому что ANSI — это невидимые символы внутри строки.

---

### 4. Чего НЕ трогать

| Не трогать | Почему |
|------------|--------|
| `message_update` | Испортит persisted content — история сессии и `/export` будут без разметки |
| `event.input` в `tool_call` | Это для tool-аргументов, не для отображения markdown |
| `MarkdownTheme` alone | Тема не контролирует visibility символов, только цвет текста |

---

### 5. Debug: посмотреть реальный вывод render()

Перед тем как писать regex, агент должен увидеть, что реально выдаёт `render()`:

```typescript
// Временный debug-кусок в extension
const proto = (AssistantMessageComponent as any).prototype;
const orig = proto.render;
proto.render = function(width: number) {
  const lines = orig.call(this, width);
  console.log("[MD-DEBUG]", JSON.stringify(lines.slice(0, 5))); // первые 5 строк
  return lines;
};
```

Запусти `pi`, дождись assistant-сообщения с markdown — в терминале (где запущен pi) увидишь raw строки. По ним подгоняй regex.

---

### 6. Архитектура из pi-tool-codex — что переиспользовать

| Файл из архива | Что взять |
|----------------|-----------|
| `assistant-message-style.ts` | Паттерн `patchAssistantMessagePrototype` + `before_agent_start` для перепатчивания |
| `user-message-box-patch.ts` | Утилита `patchUserMessageRenderPrototype` — reversible patch с версионированием |
| `user-message-box-renderer.ts` | Как оборачивать `render()` в дополнительную логику (рамки, padding) |

**Не нужно переиспользовать:** `tool-overrides.ts`, `config-store.ts`, `types.ts` — это про tool display modes, не про markdown cleanup.

---

### 7. Итоговая структура extension

```typescript
// md-clean-symbols.ts
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PATCH_VERSION = 1;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// ... cleanMarkdownSymbols() из раздела 3
// ... patchRender() из раздела 2

export default function (pi: ExtensionAPI): void {
  const proto = (AssistantMessageComponent as any).prototype;
  patchRender(proto, cleanMarkdownSymbols);

  pi.on("before_agent_start", async () => {
    patchRender((AssistantMessageComponent as any).prototype, cleanMarkdownSymbols);
  });
}
```

Установка: скопировать в `~/.pi/agent/extensions/md-clean-symbols.ts` или `./.pi/extensions/md-clean-symbols.ts`. Автозагрузка — при старте Pi.