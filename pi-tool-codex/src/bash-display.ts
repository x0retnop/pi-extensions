import { renderBlinkingToolCall } from "./tool-status-bullets.js";
import { renderDevToolAccent, renderToolAccent, renderToolLabel } from "./tool-label-style.js";

const BASH_TIMING_STATE_KEY = "__piToolDisplayBashTiming";
const SHOW_PENDING_BASH_STATUS = {
	showPendingWhenStarted: true,
	showPendingWhilePartial: true,
} as const;

interface BashCallArgs {
	command?: string;
	timeout?: number;
}

interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BashTimingState {
	startedAt?: number;
}

interface BashTimingStateCarrier {
	[BASH_TIMING_STATE_KEY]?: BashTimingState;
}

interface BashCallRenderContextLike {
	executionStarted: boolean;
	isPartial: boolean;
	invalidate(): void;
	lastComponent?: unknown;
	state?: unknown;
}

function isDevelopmentCommand(command: string | undefined): boolean {
	if (!command) {
		return false;
	}

	const normalized = command.trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	return /^(npm|pnpm|yarn|bun)\s+(test|run\s+(build|check|lint|typecheck|ci|verify|test)|build|check|lint|typecheck)\b/.test(normalized)
		|| /^(npx|pnpm dlx)\s+(tsx|vitest|jest|eslint|tsc)\b/.test(normalized)
		|| /^(tsc|vitest|jest|pytest|cargo\s+(test|build|check)|go\s+test)\b/.test(normalized);
}

function toStateCarrier(value: unknown): BashTimingStateCarrier | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return value as BashTimingStateCarrier;
}

function getOrCreateTimingState(value: unknown): BashTimingState | undefined {
	const carrier = toStateCarrier(value);
	if (!carrier) {
		return undefined;
	}

	const existing = carrier[BASH_TIMING_STATE_KEY];
	if (existing) {
		return existing;
	}

	const created: BashTimingState = {};
	carrier[BASH_TIMING_STATE_KEY] = created;
	return created;
}

function stopTiming(state: BashTimingState | undefined): void {
	if (!state) {
		return;
	}
	state.startedAt = undefined;
}

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}

	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m ${seconds}s`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes}m`;
}

function buildBashCallText(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	showRunningLabel: boolean,
	elapsedMs?: number,
): string {
	const commandDisplay =
		typeof args.command === "string" && args.command.trim().length > 0
			? args.command
			: "...";
	const isDevCommand = isDevelopmentCommand(commandDisplay);
	const label = showRunningLabel ? "Running" : "$";
	const accent = isDevCommand ? renderDevToolAccent(commandDisplay) : renderToolAccent(commandDisplay);
	const timeoutSuffix = args.timeout
		? theme.fg("muted", ` (timeout ${args.timeout}s)`)
		: "";
	const elapsedSuffix =
		elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";

	return `${renderToolLabel(theme, label)} ${accent}${timeoutSuffix}${elapsedSuffix}`;
}

export function renderBashCall(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
): ReturnType<typeof renderBlinkingToolCall> {
	const timingState = getOrCreateTimingState(context.state);
	const shouldSpin = context.executionStarted && context.isPartial;

	if (shouldSpin && timingState) {
		timingState.startedAt ??= Date.now();
	}

	if (!shouldSpin) {
		stopTiming(timingState);
	}

	return renderBlinkingToolCall(
		() => {
			const elapsedMs = shouldSpin && timingState?.startedAt !== undefined
				? Date.now() - timingState.startedAt
				: undefined;
			return buildBashCallText(args, theme, shouldSpin, elapsedMs);
		},
		theme,
		context,
		SHOW_PENDING_BASH_STATUS,
	);
}

export { isDevelopmentCommand };
