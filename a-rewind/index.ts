import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXT = "a-rewind";
const STATE_TYPE = "a-rewind-state";

const FILTER_MARKER = "[a-rewind:filtered-invalid-assistant-preamble]";
const REPAIR_MARKER = "[a-rewind:hidden-repair-instruction]";

type AutoMode = "on" | "off";

type State = {
	auto: boolean;
	retryPending: boolean;
	lastUserText: string;
};

const state: State = {
	auto: false,
	retryPending: false,
	lastUserText: "",
};

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function notify(ctx: any, message: string, level = "info"): void {
	const text = message.startsWith("[a-rewind]") ? message : `[a-rewind] ${message.replace(/^a-rewind:?\s*/, "")}`;
	if (ctx?.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(text, level);
		return;
	}
	const log = level === "error" ? console.error : console.log;
	log(text);
}

function safeSetStatus(ctx: any, id: string, value: string): void {
	if (ctx?.hasUI && ctx.ui?.setStatus) ctx.ui.setStatus(id, value);
}

export default function aRewind(pi: ExtensionAPI) {
	pi.on("session_start", async (_event: any, ctx: any) => {
		restoreState(ctx);
		renderStatus(ctx);
	});

	pi.on("message_end", async (event: any, ctx: any) => {
		try {
			const msg = event.message;
			if (!msg) return;

			if (msg.role === "user") {
				state.lastUserText = extractText(msg);
				return;
			}

			if (msg.role !== "assistant") return;

			const assistantText = extractText(msg);
			const badPreamble =
				!hasToolCalls(msg) &&
				looksLikeFailedToolIntent(assistantText, state.lastUserText);

			if (!badPreamble) {
				if (state.retryPending) state.retryPending = false;
				return;
			}

			if (!state.auto) {
				notify(ctx, 
					"a-rewind: detected suspicious assistant preamble. Use /a-rewind-last to rewind manually.",
					"warning",
				);
				return;
			}

			const replacement = makeFilteredAssistantMessage(msg);

			if (state.retryPending) {
				state.retryPending = false;
				notify(ctx, 
					"a-rewind: model repeated invalid preamble after auto-retry. Filtered it from future context; use /a-rewind-last if needed.",
					"error",
				);
				return { message: replacement };
			}

			state.retryPending = true;

			notify(ctx, 
				"a-rewind: filtered invalid assistant preamble and queued one repair retry.",
				"warning",
			);

			pi.sendMessage(
				{
					customType: EXT,
					content: `${REPAIR_MARKER}

The previous assistant output was invalid: it announced or described tool use in visible text but emitted no structured tool call.

Redo the turn.

Rules:
- If work is needed, emit actual structured tool calls.
- Do not write "using tools", "need implement", "let me inspect", plans, TODOs, or tool-use announcements as visible assistant text.
- If no tool is needed, answer normally and directly.
- Do not imitate tool calls in text.`,
					display: false,
					details: {
						reason: "failed-tool-preamble",
						at: Date.now(),
					},
				},
				{
					triggerTurn: true,
					deliverAs: "followUp",
				},
			);

			return { message: replacement };
		} catch (err) {
			notify(ctx, formatError(err), "error");
			return undefined;
		}
	});

	pi.on("context", async (event: any) => {
		let changed = false;

		const messages = event.messages.filter((msg: any) => {
			const text = extractText(msg);

			if (text.includes(FILTER_MARKER)) {
				changed = true;
				return false;
			}

			if (text.includes(REPAIR_MARKER) && !state.retryPending) {
				changed = true;
				return false;
			}

			return true;
		});

		if (changed) return { messages };
	});

	pi.registerCommand("a-rewind-auto", {
		description: "Enable, disable, or show a-rewind auto guard: /a-rewind-auto on|off|status",
		handler: async (args: string, ctx: any) => {
			try {
			const mode = normalizeAutoArg(args);

			if (!mode) {
				notify(ctx, 
					`a-rewind auto is ${state.auto ? "on" : "off"}. Usage: /a-rewind-auto on|off|status`,
					"info",
				);
				renderStatus(ctx);
				return;
			}

			if (mode === "status") {
				notify(ctx, `a-rewind auto is ${state.auto ? "on" : "off"}.`, "info");
				renderStatus(ctx);
				return;
			}

			state.auto = mode === "on";
			state.retryPending = false;

			pi.appendEntry(STATE_TYPE, {
				auto: state.auto,
				at: Date.now(),
			});

			renderStatus(ctx);
			notify(ctx, `a-rewind auto ${state.auto ? "enabled" : "disabled"}.`, "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});

	pi.registerCommand("a-rewind-last", {
		description: "Rewind session to before the latest assistant message",
		handler: async (_args: string, ctx: any) => {
			try {
			await ctx.waitForIdle();

			const branch = ctx.sessionManager.getBranch();
			const lastAssistantEntry = findLastAssistantMessageEntry(branch);

			if (!lastAssistantEntry) {
				notify(ctx, "a-rewind: no assistant message found in current branch.", "warning");
				return;
			}

			const targetId = lastAssistantEntry.parentId;
			if (!targetId) {
				notify(ctx, "a-rewind: cannot rewind before the first session entry.", "error");
				return;
			}

			const result = await ctx.navigateTree(targetId, {
				summarize: false,
				label: "a-rewind-last",
			});

			if (result?.cancelled) {
				notify(ctx, "a-rewind: rewind cancelled.", "warning");
				return;
			}

			state.retryPending = false;
			notify(ctx, "a-rewind: rewound to before the latest assistant message.", "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});
}

function restoreState(ctx: any) {
	const entries = ctx.sessionManager.getEntries();

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];

		if (entry?.type === "custom" && entry?.customType === STATE_TYPE) {
			state.auto = Boolean(entry?.data?.auto);
			state.retryPending = false;
			return;
		}
	}

	state.auto = false;
	state.retryPending = false;
}

function renderStatus(ctx: any) {
	safeSetStatus(ctx, EXT, `a-rewind: auto ${state.auto ? "on" : "off"}`);
}

function normalizeAutoArg(args: string): AutoMode | "status" | undefined {
	const value = String(args || "").trim().toLowerCase();

	if (!value) return undefined;
	if (value === "on" || value === "1" || value === "true" || value === "enable" || value === "enabled") {
		return "on";
	}
	if (value === "off" || value === "0" || value === "false" || value === "disable" || value === "disabled") {
		return "off";
	}
	if (value === "status" || value === "state" || value === "?") {
		return "status";
	}

	return undefined;
}

function findLastAssistantMessageEntry(branch: any[]) {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];

		if (entry?.type === "message" && entry?.message?.role === "assistant") {
			return entry;
		}
	}

	return undefined;
}

function makeFilteredAssistantMessage(msg: any) {
	return {
		...msg,
		content: [
			{
				type: "text",
				text: `${FILTER_MARKER}
a-rewind filtered an invalid assistant preamble from future model context.`,
			},
		],
	};
}

function hasToolCalls(msg: any): boolean {
	if (!Array.isArray(msg?.content)) return false;
	return msg.content.some((block: any) => block?.type === "toolCall");
}

function extractText(msg: any): string {
	const content = msg?.content;

	if (typeof content === "string") return content;

	if (!Array.isArray(content)) return "";

	return content
		.map((block: any) => {
			if (!block) return "";
			if (block.type === "text") return block.text || "";
			if (block.type === "thinking") return block.thinking || "";
			return "";
		})
		.join("\n")
		.trim();
}

function looksLikeFailedToolIntent(text: string, userText: string): boolean {
	const t = text.trim().toLowerCase();
	const u = userText.trim().toLowerCase();

	if (!t) return false;
	if (t.length > 700) return false;

	if (t.includes(FILTER_MARKER.toLowerCase())) return false;
	if (t.includes(REPAIR_MARKER.toLowerCase())) return false;

	const suspiciousPhrases = [
		"need implement",
		"need to implement",
		"implement now",
		"now implement",
		"using tools",
		"use tools now",
		"calling tool",
		"call tool",
		"call tools",
		"let me inspect",
		"let me check",
		"i need to inspect",
		"i need inspect",
		"need inspect",
		"need edit",
		"need patch",
		"need modify",
		"i need to modify",
		"i need to read",
		"i need to check",
		"i will use",
		"i'll use",
		"use the read tool",
		"use the edit tool",
		"use the bash tool",
		"use the write tool",
	];

	const hasSuspiciousPhrase = suspiciousPhrases.some((phrase) => t.includes(phrase));
	if (!hasSuspiciousPhrase) return false;

	const userLikelyRequestedWork =
		/\b(edit|fix|patch|change|modify|read|check|inspect|run|test|implement|add|remove|update|refactor|create|write)\b/i.test(u) ||
		/(исправ|измени|изменить|добав|удали|удалить|проверь|посмотри|запусти|реализ|прочитай|открой|внеси|допиши|поправь)/i.test(u);

	return userLikelyRequestedWork;
}