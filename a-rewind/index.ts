import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDurationHMS, formatTimerStatus, setStatusBlock } from "../common/status.js";

const EXT = "a-rewind";
const TIMER_STATUS_KEY = "_";

type NotifyLevel = "info" | "warning" | "error";

let timerEnabled = true;
let activeTaskStartedAtMs: number | undefined;
let lastTaskDurationMs: number | undefined;
let completedTasksTotalMs = 0;

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function notify(ctx: any, message: string, level: NotifyLevel = "info"): void {
	const text = message.startsWith("[a-rewind]")
		? message
		: `[a-rewind] ${message.replace(/^a-rewind:?\s*/, "")}`;

	try {
		if (ctx?.hasUI && typeof ctx.ui?.notify === "function") {
			ctx.ui.notify(text, level);
		}
	} catch {
		// Never write extension diagnostics to stdout/stderr.
	}
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);

	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function startTaskTimer(): void {
	activeTaskStartedAtMs = Date.now();
}

function finishTaskTimer(): number | undefined {
	if (activeTaskStartedAtMs === undefined) return undefined;
	const durationMs = Math.max(0, Date.now() - activeTaskStartedAtMs);
	activeTaskStartedAtMs = undefined;
	lastTaskDurationMs = durationMs;
	completedTasksTotalMs += durationMs;
	return durationMs;
}

function getCurrentTotalMs(): number {
	if (activeTaskStartedAtMs === undefined) {
		return completedTasksTotalMs;
	}
	return completedTasksTotalMs + Math.max(0, Date.now() - activeTaskStartedAtMs);
}

function updateTimerStatus(ctx: any): void {
	if (!timerEnabled) {
		setStatusBlock(ctx, TIMER_STATUS_KEY, undefined);
		return;
	}

	const totalMs = getCurrentTotalMs();
	const text = formatTimerStatus({ totalMs, lastMs: lastTaskDurationMs });
	setStatusBlock(ctx, TIMER_STATUS_KEY, text);
}

function resetTimerState(): void {
	activeTaskStartedAtMs = undefined;
	lastTaskDurationMs = undefined;
	completedTasksTotalMs = 0;
}

export default function aRewind(pi: ExtensionAPI) {
	pi.on("session_start", async (_event: any, ctx: any) => {
		resetTimerState();
		updateTimerStatus(ctx);

		if (_event.reason === "resume") {
			const leaf = ctx?.sessionManager?.getLeafEntry?.();
			if (leaf?.type === "message" && leaf.message?.role === "assistant") {
				const sr = leaf.message.stopReason;
				if (sr === "aborted" || sr === "error") {
					notify(ctx, `Resumed with interrupted turn (${sr}). Use /a-rewind or /a-rewind-step, then /retry.`, "warning");
				} else if (sr === "toolUse") {
					notify(ctx, "Resumed with incomplete tool turn. Use /a-rewind or /a-rewind-step, then /retry.", "warning");
				}
			}
		}
	});

	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		startTaskTimer();
		updateTimerStatus(ctx);
	});

	pi.on("agent_end", async (_event: any, ctx: any) => {
		const durationMs = finishTaskTimer();
		if (durationMs !== undefined) {
			notify(ctx, `task time: ${formatDuration(durationMs)}`, "info");
		}
		updateTimerStatus(ctx);
	});

	pi.on("turn_end", async (_event: any, ctx: any) => {
		updateTimerStatus(ctx);
	});

	// Strip the internal retry trigger from the LLM context. It is only needed to
	// start a turn, not to be seen by the model. Keep the conversation safe by
	// ensuring the filtered context never ends on an assistant message.
	pi.on("context", async (event: any) => {
		const cleaned = event.messages.filter(
			(m: any) => !(m.role === "custom" && m.customType === "a-retry-trigger"),
		);
		if (cleaned.length === event.messages.length) {
			return undefined;
		}
		if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === "assistant") {
			cleaned.push({
				role: "user",
				content: " ",
				timestamp: Date.now(),
			});
		}
		return { messages: cleaned };
	});

	pi.registerCommand("a-rewind", {
		description: "Rewind session to before the latest assistant message",
		handler: async (_args: string, ctx: any) => {
			try {
				if (typeof ctx?.waitForIdle === "function") {
					await ctx.waitForIdle();
				}

				const branch = getCurrentBranch(ctx);
				const lastAssistantEntry = findLastAssistantMessageEntry(branch);

				if (!lastAssistantEntry) {
					notify(ctx, "no assistant message found in current branch.", "warning");
					return;
				}

				const targetId = lastAssistantEntry.parentId;
				if (!targetId) {
					notify(ctx, "cannot rewind before the first session entry.", "error");
					return;
				}

				const result = await ctx.navigateTree(targetId, {
					summarize: false,
					label: EXT,
				});

				if (result?.cancelled) {
					notify(ctx, "rewind cancelled.", "warning");
					return;
				}

				notify(ctx, "rewound to before the latest assistant message.", "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});

	pi.registerCommand("a-rewind-step", {
		description: "Rewind session one step back (undo the latest entry)",
		handler: async (_args: string, ctx: any) => {
			try {
				if (typeof ctx?.waitForIdle === "function") {
					await ctx.waitForIdle();
				}

				const leaf = ctx?.sessionManager?.getLeafEntry?.();
				if (!leaf) {
					notify(ctx, "no current leaf found in session.", "warning");
					return;
				}

				const targetId = leaf.parentId;
				if (!targetId) {
					notify(ctx, "cannot step back before the first session entry.", "error");
					return;
				}

				const result = await ctx.navigateTree(targetId, {
					summarize: false,
					label: EXT,
				});

				if (result?.cancelled) {
					notify(ctx, "step back cancelled.", "warning");
					return;
				}

				notify(ctx, "stepped back one entry.", "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});

	pi.registerCommand("a-rewind-user", {
		description: "Rewind to the latest user message (undo all agent actions after it)",
		handler: async (_args: string, ctx: any) => {
			try {
				if (typeof ctx?.waitForIdle === "function") {
					await ctx.waitForIdle();
				}

				const branch = getCurrentBranch(ctx);
				const lastUserEntry = findLastUserMessageEntry(branch);

				if (!lastUserEntry) {
					notify(ctx, "no user message found in current branch.", "warning");
					return;
				}

				const leaf = ctx?.sessionManager?.getLeafEntry?.();
				if (leaf?.id === lastUserEntry.id) {
					notify(ctx, "already at the latest user message. Nothing to rewind.", "info");
					return;
				}

				const targetId = lastUserEntry.id;
				if (!targetId) {
					notify(ctx, "cannot rewind: user message has no id.", "error");
					return;
				}

				const result = await ctx.navigateTree(targetId, {
					summarize: false,
					label: EXT,
				});

				if (result?.cancelled) {
					notify(ctx, "rewind to user message cancelled.", "warning");
					return;
				}

				notify(ctx, "rewound to the latest user message. All agent actions after it have been undone.", "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});

	pi.registerCommand("a-rewind-tt", {
		description: "Toggle task timer display in the status bar",
		handler: async (args: string, ctx: any) => {
			try {
				const arg = args.trim().toLowerCase();

				if (arg === "off" || arg === "disable" || arg === "0") {
					timerEnabled = false;
					setStatusBlock(ctx, TIMER_STATUS_KEY, undefined);
					notify(ctx, "task timer display disabled", "info");
					return;
				}

				if (arg === "on" || arg === "enable" || arg === "1") {
					timerEnabled = true;
					updateTimerStatus(ctx);
					notify(ctx, "task timer display enabled", "info");
					return;
				}

				if (arg === "status") {
					notify(ctx, `task timer display is ${timerEnabled ? "enabled" : "disabled"}`, "info");
					return;
				}

				timerEnabled = !timerEnabled;
				if (timerEnabled) {
					updateTimerStatus(ctx);
					notify(ctx, "task timer display enabled", "info");
				} else {
					setStatusBlock(ctx, TIMER_STATUS_KEY, undefined);
					notify(ctx, "task timer display disabled", "info");
				}
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});

	pi.registerCommand("retry", {
		description: "Continue the agent loop from the current session leaf",
		handler: async (_args: string, ctx: any) => {
			try {
				if (typeof ctx?.waitForIdle === "function") {
					await ctx.waitForIdle();
				}

				const leaf = ctx?.sessionManager?.getLeafEntry?.();
				if (!leaf) {
					notify(ctx, "no current leaf found in session.", "warning");
					return;
				}

				if (leaf.type === "message" && leaf.message?.role === "assistant") {
					const sr = leaf.message.stopReason;
					if (sr === "aborted" || sr === "error") {
						notify(ctx, `Last turn was interrupted (${sr}). Rewind first with /a-rewind or /a-rewind-step.`, "warning");
						return;
					}
					if (sr === "toolUse") {
						notify(ctx, "Last turn has pending tool calls without results. Rewind first with /a-rewind or /a-rewind-step.", "warning");
						return;
					}
					if (sr === "stop") {
						notify(ctx, "Last turn already completed. Nothing to retry.", "info");
						return;
					}
				}

				await pi.sendMessage(
					{ customType: "a-retry-trigger", content: " ", display: false },
					{ triggerTurn: true }
				);
				notify(ctx, "Continuing...", "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});
}

function getCurrentBranch(ctx: any): any[] {
	try {
		const branch = ctx?.sessionManager?.getBranch?.();
		return Array.isArray(branch) ? branch : [];
	} catch {
		return [];
	}
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

function findLastUserMessageEntry(branch: any[]) {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "message" && entry?.message?.role === "user") {
			return entry;
		}
	}

	return undefined;
}
