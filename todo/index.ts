/**
 * Todo Extension - compact Codex-style todo list for Pi
 *
 * What it does:
 * - Registers a `todo` tool that the LLM can call for large multi-step work.
 * - Registers `/todos` to show the current checklist.
 * - Stores state in tool result details, so branch/replay state follows session history.
 *
 * Install:
 * - Global:  ~/.pi/agent/extensions/todo.ts
 * - Project: .pi/extensions/todo.ts
 * Then run `/reload` or restart Pi.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "active" | "done";
type TodoAction = "list" | "replace" | "add" | "update" | "toggle" | "clear";
type TodoMode = "auto" | "on" | "off";

interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

interface TodoDetails {
	action: TodoAction;
	todos: Todo[];
	nextId: number;
	error?: string;
	message?: string;
}

const MAX_TODOS = 10;
const MIN_REPLACE_TODOS = 3;
const MAX_TODO_TEXT = 180;
const TOOL_NAME = "todo";

function notify(ctx: { hasUI?: boolean; ui?: { notify?: (message: string, level: string) => void } }, message: string, level = "info"): void {
	const text = `[todo] ${message}`;
	if (ctx.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(text, level);
		return;
	}
	const log = level === "error" ? console.error : console.log;
	log(text);
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "replace", "add", "update", "toggle", "clear"] as const),
	items: Type.Optional(
		Type.Array(Type.String({ description: "Todo text" }), {
			description: "Todo texts for replace. Use 3-7 concise items for normal coding tasks.",
		}),
	),
	text: Type.Optional(Type.String({ description: "Todo text for add, or replacement text for update" })),
	id: Type.Optional(Type.Number({ description: "Todo ID for update or toggle" })),
	status: Type.Optional(StringEnum(["pending", "active", "done"] as const)),
});

function sanitizeText(text: string): string {
	const cleaned = text.replace(/\s+/g, " ").trim();
	return cleaned.length > MAX_TODO_TEXT ? `${cleaned.slice(0, MAX_TODO_TEXT - 1)}…` : cleaned;
}

function cloneTodos(todos: Todo[]): Todo[] {
	return todos.map((todo) => ({ ...todo }));
}

function statusIcon(status: TodoStatus): string {
	switch (status) {
		case "done":
			return "✓";
		case "active":
			return "●";
		case "pending":
		default:
			return "○";
	}
}

function formatTodos(todos: Todo[]): string {
	if (todos.length === 0) return "No todos";
	return todos.map((t) => `${statusIcon(t.status)} #${t.id} [${t.status}] ${t.text}`).join("\n");
}

function makeDetails(action: TodoAction, todos: Todo[], nextId: number, extra: Partial<TodoDetails> = {}): TodoDetails {
	return {
		action,
		todos: cloneTodos(todos),
		nextId,
		...extra,
	};
}

class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = cloneTodos(todos);
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet.")}`, width));
		} else {
			const done = this.todos.filter((t) => t.status === "done").length;
			const active = this.todos.find((t) => t.status === "active");
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${this.todos.length} completed`)}`, width));
			if (active) lines.push(truncateToWidth(`  ${th.fg("muted", `Active: #${active.id} ${active.text}`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const icon =
					todo.status === "done"
						? th.fg("success", "✓")
						: todo.status === "active"
							? th.fg("accent", "●")
							: th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.status === "done" ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${icon} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;
	let mode: TodoMode = "auto";

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (!details) continue;

			// Backward compatibility with the official example that used `done: boolean`.
			todos = (details.todos ?? []).map((todo: Todo | (Omit<Todo, "status"> & { done?: boolean })) => ({
				id: todo.id,
				text: todo.text,
				status: "status" in todo ? todo.status : todo.done ? "done" : "pending",
			}));
			nextId = details.nextId ?? Math.max(0, ...todos.map((todo) => todo.id)) + 1;
		}
	};

	const setTodoActive = (active: boolean) => {
		const current = pi.getActiveTools();
		const hasTodo = current.includes(TOOL_NAME);
		if (active && !hasTodo) {
			pi.setActiveTools([...current, TOOL_NAME]);
		} else if (!active && hasTodo) {
			pi.setActiveTools(current.filter((name) => name !== TOOL_NAME));
		}
	};

	const syncTodoAvailability = (prompt = "") => {
		if (mode === "on") {
			setTodoActive(true);
			return;
		}
		if (mode === "off") {
			setTodoActive(false);
			return;
		}
		setTodoActive(shouldEnableTodoForPrompt(prompt));
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		syncTodoAvailability();
	});
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	pi.on("before_agent_start", async (event) => {
		syncTodoAvailability(typeof event?.prompt === "string" ? event.prompt : "");
	});
	pi.on("agent_end", async () => {
		if (mode === "auto") setTodoActive(false);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Optional planning checklist. Use only for large changes, broad refactors, multi-file migrations, or tasks with several dependent steps. Do not use for small fixes, direct answers, simple searches, or routine one-file edits.",
		promptGuidelines: [
			"Default to not using todo. Use it only when the work is large enough that a visible checklist prevents losing track.",
			"Good uses: large refactors, multi-file feature work, migration-style changes, long bug hunts, or tasks with 3+ dependent steps.",
			"Bad uses: answering questions, reading files, running checks, small fixes, one-file edits, or obvious two-step work.",
			"Create a list only with action=replace and 3-7 meaningful items. Keep exactly one item active while working.",
			"Clear the list when the large task is complete or the user asks to clear it.",
		],
		parameters: TodoParams,

		prepareArguments(args) {
			if (!args || typeof args !== "object") return args as any;
			const input = args as Record<string, unknown>;

			// Tolerate common model variants.
			if (input.action === "complete") return { ...input, action: "update", status: "done" };
			if (input.action === "start") return { ...input, action: "update", status: "active" };
			if (input.action === "set") return { ...input, action: "replace" };
			if (input.action === "create") return { ...input, action: "replace" };
			if (Array.isArray(input.todos) && input.items === undefined) {
				const items = input.todos
					.map((todo) => {
						if (typeof todo === "string") return todo;
						if (todo && typeof todo === "object" && "text" in todo && typeof todo.text === "string") return todo.text;
						return undefined;
					})
					.filter((text): text is string => typeof text === "string");
				return { ...input, items };
			}

			return args as any;
		},

		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list":
					return {
						content: [{ type: "text", text: formatTodos(todos) }],
						details: makeDetails("list", todos, nextId),
					};

				case "replace": {
					const items = params.items?.map(sanitizeText).filter(Boolean) ?? [];
					if (items.length === 0) {
						return {
							content: [{ type: "text", text: "Error: items required for replace" }],
							details: makeDetails("replace", todos, nextId, { error: "items required" }),
						};
					}
					if (items.length < MIN_REPLACE_TODOS) {
						return {
							content: [
								{
									type: "text",
									text: `Skipped todo: use this tool only for larger work with at least ${MIN_REPLACE_TODOS} meaningful steps.`,
								},
							],
							details: makeDetails("replace", todos, nextId, { message: "Skipped small task" }),
						};
					}

					const limited = items.slice(0, MAX_TODOS);
					todos = limited.map((text, index) => ({ id: index + 1, text, status: "pending" }));
					nextId = todos.length + 1;

					const suffix = items.length > MAX_TODOS ? ` Truncated to ${MAX_TODOS} items.` : "";
					return {
						content: [{ type: "text", text: `Created ${todos.length} todos.${suffix}\n${formatTodos(todos)}` }],
						details: makeDetails("replace", todos, nextId, {
							message: `Created ${todos.length} todos.${suffix}`,
						}),
					};
				}

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: makeDetails("add", todos, nextId, { error: "text required" }),
						};
					}
					if (todos.length >= MAX_TODOS) {
						return {
							content: [{ type: "text", text: `Error: todo list is limited to ${MAX_TODOS} items` }],
							details: makeDetails("add", todos, nextId, { error: `maximum ${MAX_TODOS} todos` }),
						};
					}

					const newTodo: Todo = { id: nextId++, text: sanitizeText(params.text), status: "pending" };
					todos = [...todos, newTodo];
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: makeDetails("add", todos, nextId, { message: `Added todo #${newTodo.id}` }),
					};
				}

				case "update": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for update" }],
							details: makeDetails("update", todos, nextId, { error: "id required" }),
						};
					}

					let found = false;
					todos = todos.map((todo) => {
						if (todo.id !== params.id) return todo;
						found = true;
						return {
							...todo,
							text: params.text ? sanitizeText(params.text) : todo.text,
							status: params.status ?? todo.status,
						};
					});

					if (!found) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: makeDetails("update", todos, nextId, { error: `#${params.id} not found` }),
						};
					}

					const todo = todos.find((t) => t.id === params.id)!;
					return {
						content: [{ type: "text", text: `Updated todo #${todo.id}: [${todo.status}] ${todo.text}` }],
						details: makeDetails("update", todos, nextId, { message: `Updated todo #${todo.id}` }),
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: makeDetails("toggle", todos, nextId, { error: "id required" }),
						};
					}

					let found = false;
					todos = todos.map((todo) => {
						if (todo.id !== params.id) return todo;
						found = true;
						return { ...todo, status: todo.status === "done" ? "pending" : "done" };
					});

					if (!found) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: makeDetails("toggle", todos, nextId, { error: `#${params.id} not found` }),
						};
					}

					const todo = todos.find((t) => t.id === params.id)!;
					return {
						content: [{ type: "text", text: `Todo #${todo.id} is now ${todo.status}` }],
						details: makeDetails("toggle", todos, nextId, { message: `Todo #${todo.id} is now ${todo.status}` }),
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: makeDetails("clear", todos, nextId, { message: `Cleared ${count} todos` }),
					};
				}
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("muted", `[${args.status}]`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.items?.length) text += ` ${theme.fg("dim", `(${args.items.length} items)`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			const fallback = result.content[0]?.type === "text" ? result.content[0].text : "";

			if (!details) return new Text(fallback, 0, 0);
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

			const todoList = details.todos;
			const done = todoList.filter((t) => t.status === "done").length;

			if (todoList.length === 0) {
				return new Text(theme.fg("dim", details.message ?? "No todos"), 0, 0);
			}

			let text = theme.fg("muted", `${done}/${todoList.length} done`);
			if (details.message) text += theme.fg("dim", ` — ${details.message}`);

			const display = expanded ? todoList : todoList.slice(0, 6);
			for (const t of display) {
				const icon =
					t.status === "done"
						? theme.fg("success", "✓")
						: t.status === "active"
							? theme.fg("accent", "●")
							: theme.fg("dim", "○");
				const itemText = t.status === "done" ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
				text += `\n${icon} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
			}

			if (!expanded && todoList.length > display.length) {
				text += `\n${theme.fg("dim", `... ${todoList.length - display.length} more`)}`;
			}

			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show todos on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log(formatTodos(todos));
				return;
			}

			try {
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
					return new TodoListComponent(todos, theme, () => done());
				});
			} catch (err) {
				notify(ctx, err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	pi.registerCommand("todo-mode", {
		description: "Control todo tool availability: /todo-mode auto|on|off|status",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "auto" || value === "on" || value === "off") {
				mode = value;
				syncTodoAvailability();
				notify(ctx, `mode: ${mode}`, "info");
				return;
			}

			notify(ctx, `mode: ${mode}. Usage: /todo-mode auto|on|off|status`, "info");
		},
	});
}

function shouldEnableTodoForPrompt(prompt: string | undefined): boolean {
	const text = String(prompt ?? "").toLowerCase();
	if (!text.trim()) return false;

	const explicitTodo = /\b(todo|checklist)\b|туду|чеклист/i.test(text);
	if (explicitTodo) return true;

	const bigWork =
		/\b(refactor|rewrite|migration|migrate|redesign|architecture|large|big|multi-file|cross-module|end-to-end)\b/i.test(text) ||
		/(рефактор|перепис|миграц|архитектур|крупн|больш|масштаб|многофайл|нескольк[а-яё-]*\s+(файл|модул|част)|сквозн)/i.test(text);

	const smallWork =
		/\b(small|quick|simple|minor|one-file|tiny|just|only|check|inspect|look|show|explain)\b/i.test(text) ||
		/(быстр|прост|маленьк|минорн|только|просто|посмотри|проверь|объясни|покажи|один\s+файл|точечн|минимальн)/i.test(text);

	return bigWork && !smallWork;
}
