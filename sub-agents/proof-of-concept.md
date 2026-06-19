### 1. Цель расширения (hybrid/local-subagents)
Создать минимальное, расширяемое расширение для Pi CLI, которое позволяет:
- Offload **рутинных** задач на локальную **Gemma-4 e4b Q8** (128k контекст, сильна в tool-calling, сборе/структурировании контекста, read-only анализе).
- Использовать **дешёвые cloud-модели** (в первую очередь DeepSeek V4 Flash из OpenCode Go) для задач посложнее.
- Добавить удобный **/handoff** для сохранения состояния сессии в структурированный .md.
- Главный оркестратор (Kimi / топ-модель) **не ленится** — делегирует осознанно.

**Не плодить сложную архитектуру** — взять идеи из официального subagent-примера Pi и существующих пакетов, адаптировать под свои нужды без лишних зависимостей.

### 2. Анализ моделей (DeepSeek V4 Flash vs твоя Gemma)

**DeepSeek V4 Flash** (через OpenCode Go, $10/мес после первого месяца за $5):
- Значительно сильнее Gemma-4 в coding/agentic задачах: SWE-Bench Verified ~79%, LiveCodeBench ~91.6%, лучше tool-calling и reasoning.
- 1M контекст, быстрый и очень дешёвый в использовании (десятки тысяч запросов в месяц по Flash).
- Хорошо подходит для **средней сложности** задач: code generation, moderate agentic work, refactoring, где Gemma уже слабее.
- Лимиты Go ($12/5ч, $30/нед, $60/мес в эквиваленте) — для Flash очень щедрые (31k+ запросов/5ч). Подходит для регулярного использования суб-агентов.

**Сравнение с твоей Gemma-4 e4b Q8**:
- Gemma — отличный **read-only scout** (сбор контекста, grep/analysis логов/тестов/доков, mapping). Стабильно держит сотни tool calls, почти без потери качества на Q8.
- Не давать ей правки кода, сложный дебаг, длинный reasoning.
- DeepSeek Flash — следующий уровень: можно доверять более сложным задачам (включая edits и agentic loops).

**Рекомендация**:
- **Gemma** — primary для простой рутины (scout, gather, log/doc analysis, handoff prep).
- **DeepSeek V4 Flash** — secondary для middle-tier задач.
- Топ-модель — final decisions, architecture, complex debugging, orchestration.
- В extension сделать routing по ролям + возможность указывать модель явно.

**Ссылка для доп.чтения**: [opencode.ai/go](https://opencode.ai/go) и [opencode.ai/docs/go](https://opencode.ai/docs/go/) — детали лимитов и моделей.

### 3. Handoff механизм
Очень полезная фича. Команда `/handoff [title?]` → dedicated agent (лучше Gemma или Flash) анализирует историю сессии и генерирует **handoff-YYYY-MM-DD-[title].md**.

**Структура файла** (рекомендуемая):
- Session Summary
- Current Goals / Open Tasks (с чекбоксами)
- Key Decisions & Architecture Notes
- Relevant Context (key files + snippets)
- Recent Changes
- Open Questions / Risks
- Next Steps
- How to Continue

Промпт для handoff-агента должен быть строгим: только на основе предоставленной истории, акцент на unfinished work и blockers.

### 4. Общие рекомендации по дизайну и использованию
- **Routing**: Оркестратор сам решает (или с подсказкой extension). В промптах топ-модели явно прописать: "Делегируй рутину на Gemma, middle-задачи на DeepSeek Flash, сложное — делай сам".
- **Agent definitions**: YAML-frontmatter .md файлы (scout-gemma, handoff-agent, flash-worker и т.д.). Легко редактировать.
- **Расширяемость**: Config с mapping ролей → моделей. При апгрейде на 12B/27B Gemma просто меняешь default.
- **Баланс**: Избегать over-delegation. Топ-модель должна оставаться в контроле.
- **Тестирование**: Начать с PoC на scout + handoff, потом добавить routing.

**Дополнительные ссылки для coding-агента**:
- Официальный subagent пример: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent/
- Документация extensions: https://pi.dev/docs/latest/extensions
- DeepSeek V4 Flash benchmarks (для промптов/ожиданий): ищи SWE-Bench, LiveCodeBench сравнения.
