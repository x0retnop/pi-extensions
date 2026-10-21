import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatTimerStatus, setStatusBlock } from "../common/status.js";
import { AUTO_CONTINUE_DELAYS_MS, delayForAttempt, isHardStopError } from "../common/retry-policy.js";
import {
	RETRY_TRIGGER,
	WARM_TRIGGER,
	applyTriggerContext,
} from "./trigger-context.js";
import { WARM_MAX_IDLE_MS, WARM_MIN_IDLE_MS, warmWindow } from "./warm-window.js";

const EXT = "a-rewind";
const TIMER_STATUS_KEY = "_";
const PAUSE_STATUS_KEY = "_paused";
/**
 * Toggle key for pause/resume. Extension shortcuts are registered at extension
 * startup and are NOT part of Pi's keybindings.json — `/keys` never lists this,
 * `/hotkeys` does. To move it: change this line, rebuild, restart Pi.
 */
const PAUSE_TOGGLE_KEY = "f4";

/** OpenAI prompt_cache_key hard limit; Pi session ids are UUIDs (≤36). */
const PROMPT_CACHE_KEY_MAX = 64;

type NotifyLevel = "info" | "warning" | "error";

let timerEnabled = true;
let activeTaskStartedAtMs: number | undefined;
let lastTaskDurationMs: number | undefined;
let completedTasksTotalMs = 0;
let taskToolCalls = 0;
let lastTaskToolCalls = 0;
let totalToolCalls = 0;
/** Wall clock of the last provider request — the anchor for the /warm idle clock. */
let lastRequestAtMs: number | undefined;
/** Wall clock of last agent_settled (or last assistant on resume). Fallback anchor + display. */
let lastSettledAtMs: number | undefined;

// 1s tick so the status-bar timer counts in real time while a task runs.
// (Previously it only refreshed on turn boundaries.)
let timerTick: ReturnType<typeof setInterval> | undefined;
let lastTimerCtx: any;

// Pause state: /pause sets pauseRequested, the turn_start handler turns it
// into an active wait that /continue (or abort) resolves.
let pauseRequested = false;
let pauseActive = false;
let pauseResolve: (() => void) | undefined;

// Auto-continue: a transient provider error that Pi itself will not retry again
// is answered with a hidden continue instead of a dead turn. The hook is
// agent_end (the run is still open there, so the process stays alive and print
// mode gets the continuation too) and the decision compares Pi's own classifier
// with its exhausted budget — never a race against the built-in retry.
// Ladders live in common/retry-policy.ts, shared with the sub-agent respawn loop.
let sameErrorText: string | undefined;
let sameErrorCount = 0;
let autoContinueAttempt = 0;

type RetryClassifier = (message: any) => boolean;
let classifierPromise: Promise<RetryClassifier | undefined> | undefined;

function readSettings(): any {
	try {
		return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf-8")) ?? {};
	} catch {
		return {};
	}
}

/** `aRewind.autoContinue` in settings.json, default on. */
function autoContinueEnabled(settings: any): boolean {
	return settings?.aRewind?.autoContinue !== false;
}

/** Pi's in-run retry budget per turn (`settings.retry.maxRetries`, default 3). */
function piRetryBudget(settings: any): number {
	const value = Number(settings?.retry?.maxRetries);
	return Number.isFinite(value) ? value : 3;
}

/**
 * Pi's own classifier (`pi-ai/utils/retry`), so this layer never races the
 * built-in retry: an error Pi would still retry is left to Pi. Without the
 * import we do nothing rather than guess.
 */
function loadRetryClassifier(): Promise<RetryClassifier | undefined> {
	classifierPromise ??= import("@earendil-works/pi-ai/utils/retry")
		.then((mod: any) =>
			typeof mod?.isRetryableAssistantError === "function"
				? (mod.isRetryableAssistantError as RetryClassifier)
				: undefined,
		)
		.catch(() => undefined);
	return classifierPromise;
}

/** Resolves false when the run was aborted during the wait. */
function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => resolve(true), ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve(false);
			},
			{ once: true },
		);
	});
}

function resetAutoContinue(): void {
	sameErrorText = undefined;
	sameErrorCount = 0;
	autoContinueAttempt = 0;
}

/**
 * One action for the whole cycle: request a pause, resume an active pause,
 * cancel a pending request. Used by the shortcut key; /pause and /continue
 * keep their explicit wording (they are also reachable mid-stream by typing).
 */
function togglePause(ctx: any): void {
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
		if (typeof ctx?.isIdle === "function" && ctx.isIdle()) {
			notify(ctx, "agent is idle — nothing to pause.", "warning");
			return;
		}
		pauseRequested = true;
		notify(ctx, "pause requested — agent will pause at the next turn boundary.", "info");
	} catch (err) {
		notify(ctx, formatError(err), "error");
	}
}

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

function formatClock(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
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

function startTimerTick(ctx: any): void {
	lastTimerCtx = ctx;
	if (timerTick !== undefined) return;
	timerTick = setInterval(() => {
		if (timerEnabled && activeTaskStartedAtMs !== undefined && lastTimerCtx) {
			updateTimerStatus(lastTimerCtx);
		}
	}, 1000);
}

function stopTimerTick(): void {
	if (timerTick !== undefined) {
		clearInterval(timerTick);
		timerTick = undefined;
	}
}

function getIdleMs(nowMs = Date.now()): number | undefined {
	if (activeTaskStartedAtMs !== undefined) return 0;
	// Anchor on the last request (≈ cache write); fall back to the settle clock,
	// which is all a resumed session has.
	const anchor = lastRequestAtMs ?? lastSettledAtMs;
	if (anchor === undefined) return undefined;
	return Math.max(0, nowMs - anchor);
}

function seedLastSettledFromSession(ctx: any): void {
	const branch = getCurrentBranch(ctx);
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
		const ts = Number(entry.message?.timestamp);
		if (Number.isFinite(ts) && ts > 0) {
			lastSettledAtMs = ts;
			return;
		}
	}
}

function warmWindowStatus(idleMs: number | undefined): {
	ok: boolean;
	code: "no_activity" | "busy" | "too_early" | "too_late" | "ok";
	detail: string;
} {
	const w = warmWindow(idleMs, activeTaskStartedAtMs !== undefined);
	const idle = idleMs !== undefined ? formatDuration(idleMs) : "";
	switch (w.code) {
		case "busy":
			return { ok: false, code: "busy", detail: "agent is running — idle clock is 0" };
		case "no_activity":
			return { ok: false, code: "no_activity", detail: "no prior request in this session" };
		case "too_early":
			return {
				ok: false,
				code: "too_early",
				detail: `idle ${idle} · wait ${formatDuration(w.waitMs ?? 0)} more (min ${formatDuration(WARM_MIN_IDLE_MS)})`,
			};
		case "too_late":
			return {
				ok: false,
				code: "too_late",
				detail: `idle ${idle} · past warm window (max ${formatDuration(WARM_MAX_IDLE_MS)}) — likely full rebuild, skip`,
			};
		default:
			return {
				ok: true,
				code: "ok",
				detail: `idle ${idle} · window open · ${formatDuration(w.leftMs ?? 0)} left before cut`,
			};
	}
}

function updateTimerStatus(ctx: any): void {
	if (!timerEnabled) {
		setStatusBlock(ctx, TIMER_STATUS_KEY, undefined);
		return;
	}

	const totalMs = getCurrentTotalMs();
	const text = formatTimerStatus({
		totalMs,
		lastMs: lastTaskDurationMs,
		totalCalls: totalToolCalls,
		lastCalls: lastTaskToolCalls,
	});
	// Color the time block (first segment) yellow; calls stay plain.
	const colored = text ? text.replace(/^([^|]+)/, "\x1b[33m$1\x1b[0m") : text;
	setStatusBlock(ctx, TIMER_STATUS_KEY, colored);
}

function resetTimerState(): void {
	activeTaskStartedAtMs = undefined;
	lastTaskDurationMs = undefined;
	completedTasksTotalMs = 0;
	taskToolCalls = 0;
	lastTaskToolCalls = 0;
	totalToolCalls = 0;
	lastRequestAtMs = undefined;
	lastSettledAtMs = undefined;
}

function getAffinitySessionId(ctx: any): string | undefined {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		if (typeof id !== "string") return undefined;
		const trimmed = id.trim();
		if (!trimmed) return undefined;
		return trimmed.length > PROMPT_CACHE_KEY_MAX
			? trimmed.slice(0, PROMPT_CACHE_KEY_MAX)
			: trimmed;
	} catch {
		return undefined;
	}
}

/**
 * OpenAI chat-completions body (Kimi /coding/v1, OpenCode, …).
 * Anthropic-shaped payloads put system at top level — do not add prompt_cache_key there.
 */
function isOpenAIChatPayload(payload: unknown): payload is Record<string, unknown> {
	if (!payload || typeof payload !== "object") return false;
	const p = payload as Record<string, unknown>;
	if (!Array.isArray(p.messages) || typeof p.model !== "string") return false;
	if ("system" in p) return false;
	return true;
}

export default function aRewind(pi: ExtensionAPI) {
	pi.on("session_start", async (_event: any, ctx: any) => {
		resetTimerState();
		// Resume: seed idle clock from last assistant timestamp so /warm works
		// without waiting for a new settle in this process.
		if (_event.reason === "resume") {
			seedLastSettledFromSession(ctx);
		}
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

	// /warm idle anchor: a prompt-cache entry's TTL starts when the provider
	// receives the request, so record the send time — not the settle time.
	pi.on("before_provider_request", () => {
		lastRequestAtMs = Date.now();
	});

	// Session affinity for prompt-cache routing (free; not a keep-alive).
	// Headers: sticky cluster hint for Kimi anthropic + openai paths and similar gateways.
	// Body prompt_cache_key: only OpenAI-shaped payloads (Kimi docs; Pi often omits it).
	pi.on("before_provider_headers", (event: any, ctx: any) => {
		const id = getAffinitySessionId(ctx);
		if (!id || !event?.headers || typeof event.headers !== "object") return;
		// Do not overwrite if something else already set a sticky key.
		if (event.headers["x-session-affinity"] == null) {
			event.headers["x-session-affinity"] = id;
		}
		if (event.headers["x-session-id"] == null) {
			event.headers["x-session-id"] = id;
		}
	});

	pi.on("before_provider_request", (event: any, ctx: any) => {
		const id = getAffinitySessionId(ctx);
		if (!id) return undefined;
		const payload = event?.payload;
		if (!isOpenAIChatPayload(payload)) return undefined;
		if (payload.prompt_cache_key != null && payload.prompt_cache_key !== "") {
			return undefined;
		}
		return { ...payload, prompt_cache_key: id };
	});

	// The timer hooks are agent_start/agent_settled (not before_agent_start/
	// agent_end): sendMessage(triggerTurn) — used by /retry — and steering or
	// follow-up continuations never emit before_agent_start, so those runs were
	// invisible to the timer. agent_settled fires once per full run, after all
	// queued continuations, so one notification covers the whole task.
	pi.on("agent_start", async (_event: any, ctx: any) => {
		if (activeTaskStartedAtMs === undefined) {
			startTaskTimer();
			taskToolCalls = 0;
		}
		updateTimerStatus(ctx);
		startTimerTick(ctx);
	});

	/**
	 * Auto-continue. Runs inside `agent_end` — the run is still open there, which is
	 * what lets a *print-mode child* continue too (a timer after `agent_settled`
	 * loses the race with process exit). It acts only when Pi will not retry again:
	 * either its classifier says the error is not retryable, or the same text came
	 * back more times than the retry budget allows. Hard-stop errors (quota, auth,
	 * invalid request, context overflow) are left to fail loudly — the same request
	 * would earn the same answer.
	 */
	const handleAgentEnd = async (event: any, ctx: any): Promise<void> => {
		const messages = Array.isArray(event?.messages) ? event.messages : [];
		const last = [...messages].reverse().find((m: any) => m?.role === "assistant");
		if (!last || last.stopReason !== "error") {
			resetAutoContinue();
			return;
		}
		const errText = String(last.errorMessage ?? "unknown provider error");
		if (isHardStopError(errText)) {
			resetAutoContinue();
			return;
		}
		const settings = readSettings();
		if (!autoContinueEnabled(settings)) return;

		if (errText === sameErrorText) sameErrorCount++;
		else {
			sameErrorText = errText;
			sameErrorCount = 1;
			autoContinueAttempt = 0;
		}

		const piGaveUp = sameErrorCount > piRetryBudget(settings);
		if (!piGaveUp) {
			// Still inside Pi's own budget: leave the attempt chain to Pi.
			const classifier = await loadRetryClassifier();
			if (!classifier || classifier(last)) return;
		}

		if (autoContinueAttempt >= AUTO_CONTINUE_DELAYS_MS.length) {
			notify(
				ctx,
				`provider error persists after ${AUTO_CONTINUE_DELAYS_MS.length} auto-continues — ${headline(errText)}`,
				"warning",
			);
			resetAutoContinue();
			return;
		}
		autoContinueAttempt++;
		const delayMs = delayForAttempt(AUTO_CONTINUE_DELAYS_MS, autoContinueAttempt);
		notify(
			ctx,
			`provider error, auto-continue ${autoContinueAttempt}/${AUTO_CONTINUE_DELAYS_MS.length} in ${Math.round(delayMs / 1000)}s — ${headline(errText)}`,
			"info",
		);
		const signal: AbortSignal | undefined = ctx?.signal;
		if (!(await sleepAbortable(delayMs, signal))) return;
		try {
			await pi.sendMessage({ customType: RETRY_TRIGGER, content: " ", display: false }, { triggerTurn: true });
		} catch (err) {
			notify(ctx, formatError(err), "error");
		}
	};

	pi.on("agent_end", handleAgentEnd);

	pi.on("agent_settled", async (_event: any, ctx: any) => {
		lastSettledAtMs = Date.now();
		const durationMs = finishTaskTimer();
		if (durationMs !== undefined) {
			lastTaskToolCalls = taskToolCalls;
			// Task-time summary notify removed (2026-08): ui-theme turn log already
			// reports duration + tool count per turn (zz-turn status + scrollback
			// ui-turn entry), more fully. Per-task totals incl. pause time are lost;
			// re-add as an option if wanted.
		}
		// A pause requested during the final turn never reaches a turn boundary.
		pauseRequested = false;
		updateTimerStatus(ctx);
		stopTimerTick();
	});

	pi.on("turn_end", async (event: any, ctx: any) => {
		const results = Array.isArray(event?.toolResults) ? event.toolResults : [];
		taskToolCalls += results.length;
		totalToolCalls += results.length;
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
		resetAutoContinue();
		stopTimerTick();
	});

	// Retry: drop trigger; empty user placeholder if the leaf is assistant.
	// Warm: one-shot ping cue only while the trigger is the last message.
	// Later turns strip the trigger *and* the ping reply so "do not use tools"
	// cannot stick onto the next real task.
	pi.on("context", async (event: any) => {
		const cleaned = applyTriggerContext(event.messages);
		if (!cleaned) return undefined;
		return { messages: cleaned as any };
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

				await navigateToEntry(ctx, targetId, "Rewound.");
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

				await navigateToEntry(ctx, targetId, "Stepped back one entry.");
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

				await navigateToEntry(ctx, targetId, "Rewound to the latest user message.");
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
					stopTimerTick();
					setStatusBlock(ctx, TIMER_STATUS_KEY, undefined);
					notify(ctx, "task timer display disabled", "info");
					return;
				}

				if (arg === "on" || arg === "enable" || arg === "1") {
					timerEnabled = true;
					updateTimerStatus(ctx);
					startTimerTick(ctx);
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

				// After a rewind, the leaf is the "a-rewind" label entry, not the
				// target. If that target was a user message, navigateTree moved the
				// message into the editor (its re-edit semantics) and the branch no
				// longer contains it — retrying here would feed the LLM a context
				// without the user's last instruction.
				if (leaf.type === "label" && leaf.label === EXT && leaf.targetId) {
					const target = ctx?.sessionManager?.getEntry?.(leaf.targetId);
					if (target?.type === "message" && target.message?.role === "user") {
						notify(
							ctx,
							"Your last message was moved to the editor by the rewind — press Enter to re-send it (the turn starts automatically).",
							"warning",
						);
						return;
					}
				}

				// Guards must look at the last message in the branch, not the leaf:
				// after a rewind the leaf is the label entry, so leaf-based checks
				// would never fire and broken turns would be retried.
				const lastMessageEntry = [...getCurrentBranch(ctx)]
					.reverse()
					.find((e) => e?.type === "message");

				if (!lastMessageEntry) {
					notify(ctx, "Nothing to continue from — the session is empty at this point. Send a message first.", "warning");
					return;
				}

				if (lastMessageEntry.message?.role === "assistant") {
					const sr = lastMessageEntry.message.stopReason;
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
					{ customType: RETRY_TRIGGER, content: " ", display: false },
					{ triggerTurn: true },
				);
				notify(ctx, "Continuing...", "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});

	// One key toggles the whole pause cycle: request -> paused -> resumed.
	pi.registerShortcut(PAUSE_TOGGLE_KEY, {
		description: "a-rewind: pause / resume the agent loop",
		handler: async (ctx: any) => {
			togglePause(ctx);
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

	pi.registerCommand("warm", {
		description:
			"Touch prompt cache if idle is in the warm window (default 3m–4m45s). /warm | status",
		handler: async (args: string, ctx: any) => {
			try {
				const arg = (args ?? "").trim().toLowerCase();
				const idleMs = getIdleMs();
				const window = warmWindowStatus(idleMs);

				if (arg === "status" || arg === "st" || arg === "?") {
					const anchor = lastRequestAtMs ?? lastSettledAtMs;
					const ended =
						anchor !== undefined
							? `last request ${formatClock(anchor)}`
							: "last request —";
					notify(
						ctx,
						`warm: ${window.detail} · ${ended} · window ${formatDuration(WARM_MIN_IDLE_MS)}–${formatDuration(WARM_MAX_IDLE_MS)}`,
						window.ok ? "info" : "warning",
					);
					return;
				}

				if (arg && arg !== "now" && arg !== "go") {
					notify(ctx, "usage: /warm · /warm status", "warning");
					return;
				}

				if (pauseActive || pauseRequested) {
					notify(ctx, "paused — /continue first, then /warm.", "warning");
					return;
				}
				if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) {
					notify(ctx, "agent is busy — wait until idle.", "warning");
					return;
				}
				if (!window.ok) {
					notify(ctx, `warm skipped: ${window.detail}`, "warning");
					return;
				}

				// Same label-as-leaf caveat as /retry: after a rewind the leaf is the
				// label entry, so check the last message in the branch instead.
				const lastMessageEntry = [...getCurrentBranch(ctx)]
					.reverse()
					.find((e) => e?.type === "message");
				if (lastMessageEntry?.message?.role === "assistant") {
					const sr = lastMessageEntry.message.stopReason;
					if (sr === "aborted" || sr === "error" || sr === "toolUse") {
						notify(
							ctx,
							`last message is ${sr} — rewind to a clean state before /warm.`,
							"warning",
						);
						return;
					}
				}

				await pi.sendMessage(
					{ customType: WARM_TRIGGER, content: " ", display: false },
					{ triggerTurn: true },
				);
				notify(ctx, `warming… (${window.detail})`, "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});
}

async function navigateToEntry(ctx: any, targetId: string, okMessage: string): Promise<void> {
	const branch = getCurrentBranch(ctx);
	const targetIdx = branch.findIndex((e) => e?.id === targetId);
	const removedMessages =
		targetIdx >= 0
			? branch.slice(targetIdx + 1).filter((e) => e?.type === "message").length
			: -1;

	const result = await ctx.navigateTree(targetId, {
		summarize: false,
		label: EXT,
	});

	if (result?.cancelled) {
		notify(ctx, "rewind cancelled.", "warning");
		return;
	}

	const detail = describeRewindTarget(ctx, targetId);
	const count =
		removedMessages > 0
			? ` · removed ${removedMessages} message${removedMessages === 1 ? "" : "s"}`
			: "";
	notify(ctx, `${okMessage} Target: ${detail}.${count}`, "info");
}

function getCurrentBranch(ctx: any): any[] {
	try {
		const branch = ctx?.sessionManager?.getBranch?.();
		return Array.isArray(branch) ? branch : [];
	} catch {
		return [];
	}
}

/** One-line, length-capped error text for a notification. */
function headline(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Flatten message content (string or block array) to text. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b && typeof b === "object" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

/** Short human description of a rewind target + what the user should do next. */
function describeRewindTarget(ctx: any, targetId: string): string {
	const e = ctx?.sessionManager?.getEntry?.(targetId);
	if (!e) return "the selected point";
	if (e.type === "message") {
		const m = e.message ?? {};
		if (m.role === "user") {
			const text = messageText(m.content).trim();
			const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
			const shown = preview ? `"${preview}"` : "(empty)";
			return `your message ${shown} — it was moved to the editor, press Enter to re-send`;
		}
		if (m.role === "assistant") return `the assistant message (${m.stopReason ?? "?"})`;
		if (m.role === "toolResult") return `the tool result (${m.toolName ?? "?"}) — /retry to continue`;
		return `the ${m.role ?? "?"} message`;
	}
	if (e.type === "custom_message") return `the custom message (${e.customType ?? "?"})`;
	return `the ${e.type} entry`;
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
