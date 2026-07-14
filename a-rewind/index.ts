import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatTimerStatus, setStatusBlock } from "../common/status.js";

const EXT = "a-rewind";
const TIMER_STATUS_KEY = "_";
const PAUSE_STATUS_KEY = "_paused";

type NotifyLevel = "info" | "warning" | "error";

let timerEnabled = true;
let activeTaskStartedAtMs: number | undefined;
let lastTaskDurationMs: number | undefined;
let completedTasksTotalMs = 0;

// Pause state: /pause sets pauseRequested, the turn_start handler turns it
// into an active wait that /continue (or abort) resolves.
let pauseRequested = false;
let pauseActive = false;
let pauseResolve: (() => void) | undefined;

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

		// Defensive reset: a pending pause must never leak into a new session.
		pauseRequested = false;
		pauseResolve?.();

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

	// The timer hooks are agent_start/agent_settled (not before_agent_start/
	// agent_end): sendMessage(triggerTurn) — used by /retry — and steering or
	// follow-up continuations never emit before_agent_start, so those runs were
	// invisible to the timer. agent_settled fires once per full run, after all
	// queued continuations, so one notification covers the whole task.
	pi.on("agent_start", async (_event: any, ctx: any) => {
		if (activeTaskStartedAtMs === undefined) {
			startTaskTimer();
		}
		updateTimerStatus(ctx);
	});

	pi.on("agent_settled", async (_event: any, ctx: any) => {
		const durationMs = finishTaskTimer();
		if (durationMs !== undefined) {
			notify(ctx, `task time: ${formatDuration(durationMs)}`, "info");
		}
		// A pause requested during the final turn never reaches a turn boundary.
		pauseRequested = false;
		updateTimerStatus(ctx);
	});

	pi.on("turn_end", async (_event: any, ctx: any) => {
		updateTimerStatus(ctx);
	});

	// /pause implementation: the agent loop awaits turn_start handlers before
	// each LLM request, at a point where the previous assistant message and all
	// its tool results are already persisted and no HTTP stream is open. Waiting
	// here freezes the loop at a clean boundary without touching history.
	pi.on("turn_start", async (_event: any, ctx: any) => {
		if (!pauseRequested || pauseActive) return;
		pauseRequested = false;

		const signal: AbortSignal | undefined = ctx?.signal;
		if (signal?.aborted) return; // run is already dying; don't pause it

		pauseActive = true;
		const pausedAtMs = Date.now();
		setStatusBlock(ctx, PAUSE_STATUS_KEY, "⏸ paused");
		notify(ctx, "paused at turn boundary. Use /continue to resume.", "info");

		try {
			await new Promise<void>((resolve) => {
				pauseResolve = () => {
					pauseResolve = undefined;
					signal?.removeEventListener("abort", onAbort);
					resolve();
				};
				const onAbort = () => pauseResolve?.();
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		} finally {
			pauseActive = false;
			setStatusBlock(ctx, PAUSE_STATUS_KEY, undefined);
			// Exclude paused wall time from the task timer.
			if (activeTaskStartedAtMs !== undefined) {
				activeTaskStartedAtMs += Date.now() - pausedAtMs;
			}
			updateTimerStatus(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		pauseRequested = false;
		pauseResolve?.();
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

				await navigateToEntry(ctx, targetId, "rewound to before the latest assistant message.");
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

				await navigateToEntry(ctx, targetId, "stepped back one entry.");
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

				await navigateToEntry(ctx, targetId, "rewound to the latest user message. All agent actions after it have been undone.");
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

	pi.registerCommand("pause", {
		description: "Pause the agent loop at the next turn boundary (resume with /continue)",
		handler: async (_args: string, ctx: any) => {
			try {
				if (pauseActive) {
					notify(ctx, "already paused. Use /continue to resume.", "info");
					return;
				}
				if (pauseRequested) {
					notify(ctx, "pause already requested — will pause at the next turn boundary.", "info");
					return;
				}
				if (typeof ctx?.isIdle === "function" && ctx.isIdle()) {
					notify(ctx, "agent is idle — nothing to pause.", "warning");
					return;
				}
				pauseRequested = true;
				notify(ctx, "pause requested — agent will pause at the next turn boundary.", "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});

	pi.registerCommand("continue", {
		description: "Resume an agent loop paused with /pause",
		handler: async (_args: string, ctx: any) => {
			try {
				if (pauseActive) {
					notify(ctx, "continuing...", "info");
					pauseResolve?.();
					return;
				}
				if (pauseRequested) {
					pauseRequested = false;
					notify(ctx, "pause request cancelled.", "info");
					return;
				}
				notify(ctx, "not paused.", "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});
}

async function navigateToEntry(ctx: any, targetId: string, okMessage: string): Promise<void> {
	const result = await ctx.navigateTree(targetId, {
		summarize: false,
		label: EXT,
	});

	if (result?.cancelled) {
		notify(ctx, "rewind cancelled.", "warning");
		return;
	}

	notify(ctx, okMessage, "info");
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
