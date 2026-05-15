# AGENTS.md

Контекст для агентов, работающих в этом репозитории. Цель — быстро понять проект и не тратить контекст на шум.

## Что это за проект

Это коллекция расширений для **Pi Coding Agent**: <https://pi.dev/docs/latest>.

Pi — минимальный терминальный coding harness, который расширяется через TypeScript-модули, skills, prompt templates, themes и pi packages. Расширения могут:

- регистрировать tools для модели через `pi.registerTool()`;
- добавлять slash-команды через `pi.registerCommand()`;
- подписываться на события жизненного цикла, сессий, сообщений, tool calls/results;
- менять/блокировать tool calls, добавлять контекст, управлять compaction/session flows;
- взаимодействовать с пользователем через `ctx.ui` (`notify`, `confirm`, `select`, custom TUI);
- хранить состояние через session entries и session manager.

Этот репозиторий — не одно приложение, а набор самостоятельных pi packages. Почти каждый верхнеуровневый каталог с `package.json` — отдельный пакет, который можно установить отдельно через `pi install ./folder` или из git/npm.

## Структура репозитория

Корень:

- `package.json`, `tsconfig.json` — dev-окружение для TypeScript-проверки всей коллекции.
- `README.md` — публичное описание коллекции и install examples.
- `commanddb.json` — данные, связанные с permission gate / command DB.
- `_test_*.py`, `_proof.py`, `_temp_checkdb.py` — старые/ручные проверочные скрипты; не считай их основной архитектурой без причины.
- `node_modules/` — установленное окружение; не редактировать.
- `nul` — артефакт Windows/оболочки; не трогать без явного запроса.

Основные пакеты:

- `a-rewind` — защита от сообщений ассистента, которые обещают tool use без реальных tool calls; ручной rewind последнего assistant message.
- `asku` — интерактивный `ask_user_question` tool для уточняющих вопросов пользователю через TUI.
- `btw` — `/btw` для быстрых side questions с ограниченным контекстом без записи вопроса/ответа в историю сессии.
- `context` — показывает загруженный контекст, extensions, skills, tools и примерное использование токенов.
- `ctx-manager` — `/ctx`, ручное управление контекстом, toggles, compaction/handoff helpers.
- `grep-tool` — расширение/tool для grep-поиска.
- `handoff` — генерирует focused handoff prompt и помогает перейти в новую сессию.
- `ollama-cloud-web` — добавляет `web_search` и `web_fetch` tools через Ollama Cloud.
- `permission-gate` — safety gate для `bash/read/write/edit`: анализ команд, путей, protected roots, режимы strict/balanced/relaxed/yolo.
- `pi-docs-toggle` — переключение/управление Pi docs context.
- `sessions` — `/sessions`, интерактивный lazy-loading picker для Pi sessions.
- `tm` — temperature/model-related utility extension.
- `todo` — model-callable todo checklist tool, `/todos`, `/todo-mode`.

## Стиль коллекции

У проекта намеренно минималистичный стиль:

- один extension = одна папка;
- внутри папки должны быть код, `package.json` и короткое понятное `README.md`;
- описание должно объяснять, что делает extension, как установить/включить и какие команды/tools он добавляет;
- без длинного маркетинга, лишней архитектурной прозы и больших примеров, если они не нужны для использования;
- корневой `README.md` — минималистичный каталог готовых extensions, а не подробная документация всего кода.

## Типичный пакет расширения

Обычно пакет выглядит так:

```text
some-extension/
  index.ts          # entry point, default export function(pi: ExtensionAPI)
  package.json      # name, peerDependencies, pi.extensions
  README.md         # короткое публичное описание пакета
```

Более крупные пакеты разбиты на модули:

- `handoff`: `config.ts`, `extraction.ts`, `metadata.ts`, `parser.ts`, `progress.ts`, `prompt.ts`, `types.ts`.
- `permission-gate`: `analyzer.ts`, `engine.ts`, `path-guard.ts`, `inline-scan.ts`, `tokenizer.ts`, `command-db.ts`, `types.ts`.

В `package.json` пакетов обычно есть:

```json
{
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

Pi-зависимости (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) должны оставаться peer dependencies для пакетов, если нет явной причины менять packaging.

## Важные Pi concepts для правок

- Расширение экспортирует default factory: `export default function (pi: ExtensionAPI) { ... }` или async variant.
- TypeScript исполняется Pi через runtime loader; отдельная сборка обычно не нужна.
- Tools описываются схемами параметров, часто через `typebox` `Type.Object(...)`.
- Tool execution должен возвращать content/details в формате Pi tool result.
- Event handlers могут возвращать управляющие объекты: block/cancel/modified result/context/etc. Перед изменением event flow проверь текущий API по docs или существующему коду.
- Extensions имеют полный доступ к системе пользователя; любые команды, файловые операции и network-интеграции требуют осторожности.

Официальные docs при необходимости: <https://pi.dev/docs/latest>. Особенно полезны разделы `Extensions`, `Pi Packages`, `Session format`, `TUI components`.

## Как работать с контекстом

- Не читай всё подряд. В этом репозитории много маленьких независимых пакетов.
- Сначала найди релевантный пакет/символ через `rg`.
- Читай `README.md`, `package.json` и конкретные `.ts` файлы только того пакета, которого касается задача.
- Для больших файлов читай фрагменты вокруг найденных мест.
- Не подтягивай `node_modules` и lock-файлы, если задача не про них.

## Правила правок

- Делай точечные изменения в рамках задачи.
- Сохраняй стиль конкретного файла: ESM, именование, формат ошибок, UI messages.
- Сохраняй минимализм: лучше ясный маленький модуль и короткое описание, чем универсальный фреймворк внутри extension.
- Не делай broad cleanup, массовое форматирование, переименование файлов или архитектурные перестройки без запроса.
- Не меняй зависимости, lock-файлы и package metadata без явного разрешения.
- Не редактируй generated/vendor-like данные, если это не суть задачи.

## README и документация

Не обновляй README механически после каждой правки. Действуй по смыслу:

- если extension ещё в разработке/эксперименте и задача про код — не превращай README в обязательный шум;
- если extension стал рабочим, добавлена/изменена команда, tool, install flow или публичное поведение — обнови README этого extension, даже если пользователь отдельно не попросил;
- если готовый extension добавлен, удалён, переименован или существенно поменял назначение — обнови корневой `README.md` как каталог;
- если изменение внутреннее и пользовательский интерфейс не поменялся — README обычно не трогай;
- если не уверен, лучше в финальном ответе кратко напомни: `Стоит обновить README после стабилизации поведения.`

## Проверки

Разрешённые быстрые проверки по ситуации:

- TypeScript: `npx --no-install tsc --noEmit`.
- Точечный поиск на регрессии: `rg "symbol-or-command" package-dir`.
- Для Python-скриптов, если их трогали: `python -m py_compile file.py`.

Не запускать без явного запроса:

- install/update зависимостей;
- production build;
- watch mode;
- полные тестовые наборы;
- generators/migrations;
- публикацию пакетов.

Если правка только в docs/AGENTS.md/comments, проверка обычно не нужна.

## Git и безопасность

- Git только read-only: можно `git status`, `git diff`; нельзя commit, push, branch, merge, reset.
- Не выходи за пределы проекта без разрешения.
- Не отправляй приватные данные проекта во внешние сервисы. Официальные Pi docs можно читать, когда это помогает задаче.
- Не выполняй destructive actions: массовые удаления, clean/reset, force checkout, форматирование всего дерева.

## Коммуникация

- Отвечай кратко по-русски.
- Сообщай результат, блокер или один конкретный вопрос.
- Не пересказывай terminal output, diff или список tool calls — пользователь это видит.
