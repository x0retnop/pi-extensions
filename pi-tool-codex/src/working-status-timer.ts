import { InteractiveMode, keyText } from "@mariozechner/pi-coding-agent";
import { TOOL_HISTORY_INDENT } from "./tool-status-bullets.js";

const WORKING_TIMER_PATCH_VERSION = 3;
const WORKING_TIMER_STATE_KEY = "__piToolViewWorkingTimerState";
const WORK_TURN_STATE_KEY = "__piToolViewWorkTurnState";
const DEFAULT_WORKING_LABEL = "Working";
const FALLBACK_INTERRUPT_KEY = "esc";
const ANSI_DIM = "\x1b[2m";
const ANSI_DIM_RESET = "\x1b[22m";
const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

interface LoaderLike {
	message?: unknown;
	setMessage(message: string): void;
	stop(): void;
}

interface WorkingTimerState {
	loader: LoaderLike;
	interval?: ReturnType<typeof setInterval>;
	originalSetMessage: (message: string) => void;
	originalStop: () => void;
	rawMessage: string;
	startedAtMs: number;
}

interface ChatContainerLike {
	addChild(component: unknown): void;
	removeChild(component: unknown): void;
	children?: unknown[];
}

interface UiLike {
	requestRender(): void;
}

interface WorkTurnState {
	turnStartedAtMs: number;
	lastSeparatorAtMs?: number;
	needsFinalMessageSeparator: boolean;
	hadWorkActivity: boolean;
}

interface PatchableInteractiveModeInstance {
	loadingAnimation?: LoaderLike;
	defaultWorkingMessage?: unknown;
	chatContainer?: ChatContainerLike;
	streamingComponent?: unknown;
	ui?: UiLike;
	[WORKING_TIMER_STATE_KEY]?: WorkingTimerState;
	[WORK_TURN_STATE_KEY]?: WorkTurnState;
}

interface PatchableInteractiveModePrototype {
	handleEvent(event: unknown): Promise<unknown>;
	stop(): void;
	__piToolViewWorkingTimerPatchVersion?: number;
	__piToolViewWorkingTimerOriginalHandleEvent?: (event: unknown) => Promise<unknown>;
	__piToolViewWorkingTimerOriginalStop?: () => void;
}

interface AssistantContentBlockLike {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
}

function isLoaderLike(value: unknown): value is LoaderLike {
	return Boolean(value)
		&& typeof value === "object"
		&& typeof (value as LoaderLike).setMessage === "function"
		&& typeof (value as LoaderLike).stop === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractAssistantMessage(event: unknown): { role?: unknown; content?: unknown } | undefined {
	if (!isRecord(event) || !isRecord(event.message)) {
		return undefined;
	}

	return event.message as { role?: unknown; content?: unknown };
}

function hasVisibleAssistantText(event: unknown): boolean {
	const message = extractAssistantMessage(event);
	if (!message || message.role !== "assistant") {
		return false;
	}

	if (!Array.isArray(message.content)) {
		return false;
	}

	return message.content.some((block) => {
		if (!isRecord(block)) {
			return false;
		}

		const content = block as AssistantContentBlockLike;
		return content.type === "text"
			&& typeof content.text === "string"
			&& content.text.trim().length > 0;
	});
}

function hasAssistantToolCalls(event: unknown): boolean {
	const message = extractAssistantMessage(event);
	if (!message || message.role !== "assistant") {
		return false;
	}

	if (!Array.isArray(message.content)) {
		return false;
	}

	return message.content.some((block) =>
		isRecord(block) && (block as AssistantContentBlockLike).type === "toolCall"
	);
}

function getAssistantMessageEventType(event: unknown): string | undefined {
	if (!isRecord(event) || !isRecord(event.assistantMessageEvent)) {
		return undefined;
	}

	const eventType = event.assistantMessageEvent.type;
	return typeof eventType === "string" ? eventType : undefined;
}

function hasVisibleAssistantTextDelta(event: unknown): boolean {
	if (getAssistantMessageEventType(event) !== "text_delta") {
		return false;
	}

	if (!isRecord(event) || !isRecord(event.assistantMessageEvent)) {
		return false;
	}

	const delta = event.assistantMessageEvent.delta;
	return typeof delta === "string" && delta.trim().length > 0;
}

function isToolCallAssistantUpdate(event: unknown): boolean {
	const updateType = getAssistantMessageEventType(event);
	return updateType === "toolcall_start"
		|| updateType === "toolcall_delta"
		|| updateType === "toolcall_end";
}

function getInterruptKeyLabel(): string {
	try {
		const label = keyText("app.interrupt").trim();
		return label.length > 0 ? label : FALLBACK_INTERRUPT_KEY;
	} catch {
		return FALLBACK_INTERRUPT_KEY;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDefaultWorkingLabel(value: string): string {
	return /^working\.\.\.$/i.test(value) ? value.slice(0, -3) : value;
}

function getFallbackWorkingLabel(defaultWorkingMessage: unknown): string {
	if (typeof defaultWorkingMessage !== "string") {
		return DEFAULT_WORKING_LABEL;
	}

	const trimmed = defaultWorkingMessage.trim();
	return trimmed.length > 0
		? normalizeDefaultWorkingLabel(trimmed)
		: DEFAULT_WORKING_LABEL;
}

function stripInterruptSuffix(message: string, interruptKey: string): string {
	const trimmed = message.trim();
	const directSuffixes = [
		` (${interruptKey} to interrupt)`,
		` (${FALLBACK_INTERRUPT_KEY} to interrupt)`,
	];

	for (const suffix of directSuffixes) {
		if (trimmed.endsWith(suffix)) {
			return trimmed.slice(0, -suffix.length).trimEnd();
		}
	}

	const elapsedPattern = new RegExp(
		`\\s\\((?:\\d+s|\\d+m \\d{2}s|\\d+h \\d{2}m \\d{2}s) • ${escapeRegExp(interruptKey)} to interrupt\\)$`,
	);
	if (elapsedPattern.test(trimmed)) {
		return trimmed.replace(elapsedPattern, "").trimEnd();
	}

	const fallbackElapsedPattern =
		/\s\((?:\d+s|\d+m \d{2}s|\d+h \d{2}m \d{2}s) • esc to interrupt\)$/;
	if (fallbackElapsedPattern.test(trimmed)) {
		return trimmed.replace(fallbackElapsedPattern, "").trimEnd();
	}

	return trimmed;
}

export function formatElapsedCompact(elapsedSeconds: number): string {
	const safeElapsed = Math.max(0, Math.floor(elapsedSeconds));
	if (safeElapsed < 60) {
		return `${safeElapsed}s`;
	}

	if (safeElapsed < 3600) {
		const minutes = Math.floor(safeElapsed / 60);
		const seconds = safeElapsed % 60;
		return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	}

	const hours = Math.floor(safeElapsed / 3600);
	const minutes = Math.floor((safeElapsed % 3600) / 60);
	const seconds = safeElapsed % 60;
	return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

export function normalizeWorkingStatusLabel(
	message: unknown,
	defaultWorkingMessage: unknown,
	interruptKey = getInterruptKeyLabel(),
): string {
	const fallback = getFallbackWorkingLabel(defaultWorkingMessage);
	if (typeof message !== "string" || message.trim().length === 0) {
		return fallback;
	}

	const stripped = stripInterruptSuffix(message, interruptKey);
	if (!stripped) {
		return fallback;
	}

	if (typeof defaultWorkingMessage === "string" && stripped === defaultWorkingMessage.trim()) {
		return fallback;
	}

	return stripped;
}

export function formatWorkingStatusMessage(
	label: string,
	startedAtMs: number,
	interruptKey = getInterruptKeyLabel(),
	nowMs = Date.now(),
): string {
	const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
	return `${label} (${formatElapsedCompact(elapsedSeconds)} • ${interruptKey} to interrupt)`;
}

export function shouldCountToolAsWork(toolName: unknown): boolean {
	if (typeof toolName !== "string") {
		return false;
	}

	const normalized = toolName.trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	return !READ_ONLY_TOOL_NAMES.has(normalized);
}

export function shouldInsertSeparatorAfterTool(toolName: unknown): boolean {
	return typeof toolName === "string" && toolName.trim().length > 0;
}

export function formatWorkSeparatorLine(width: number, elapsedSeconds?: number): string {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth === 0) {
		return "";
	}

	if (elapsedSeconds === undefined || elapsedSeconds <= 60) {
		return "─".repeat(safeWidth);
	}

	const label = `─ Worked for ${formatElapsedCompact(elapsedSeconds)} ─`;
	if (label.length >= safeWidth) {
		return "─".repeat(safeWidth);
	}

	return `${label}${"─".repeat(safeWidth - label.length)}`;
}

export function formatWorkSeparatorLines(width: number, elapsedSeconds?: number): string[] {
	const safeWidth = Math.max(0, Math.floor(width));
	const spacerLine = " ".repeat(safeWidth);
	const separatorWidth = Math.max(0, safeWidth - TOOL_HISTORY_INDENT.length);
	const separatorText = formatWorkSeparatorLine(separatorWidth, elapsedSeconds);
	const separatorLine = separatorText ? `${TOOL_HISTORY_INDENT}${separatorText}` : spacerLine;
	return [spacerLine, spacerLine, separatorLine, spacerLine];
}

class WorkFinalSeparatorComponent {
	constructor(private readonly elapsedSeconds?: number) {}

	render(width: number): string[] {
		const lines = formatWorkSeparatorLines(width, this.elapsedSeconds);
		if (lines.length === 0) {
			return lines;
		}

		const separatorIndex = Math.max(0, lines.length - 2);
		const separatorLine = lines[separatorIndex] ?? "";
		lines[separatorIndex] = `${ANSI_DIM}${separatorLine}${ANSI_DIM_RESET}`;
		return lines;
	}
}

function getOrCreateWorkTurnState(mode: PatchableInteractiveModeInstance): WorkTurnState {
	const existing = mode[WORK_TURN_STATE_KEY];
	if (existing) {
		return existing;
	}

	const created: WorkTurnState = {
		turnStartedAtMs: Date.now(),
		needsFinalMessageSeparator: false,
		hadWorkActivity: false,
	};
	mode[WORK_TURN_STATE_KEY] = created;
	return created;
}

function resetWorkTurnState(mode: PatchableInteractiveModeInstance): void {
	mode[WORK_TURN_STATE_KEY] = {
		turnStartedAtMs: Date.now(),
		needsFinalMessageSeparator: false,
		hadWorkActivity: false,
	};
}

function getSeparatorElapsedSeconds(mode: PatchableInteractiveModeInstance, nowMs = Date.now()): number | undefined {
	const state = mode[WORK_TURN_STATE_KEY];
	if (!state) {
		return undefined;
	}

	const baseline = state.lastSeparatorAtMs ?? state.turnStartedAtMs;
	return Math.max(0, Math.floor((nowMs - baseline) / 1000));
}

function insertWorkSeparator(mode: PatchableInteractiveModeInstance, nowMs = Date.now()): boolean {
	const state = mode[WORK_TURN_STATE_KEY];
	if (!state?.needsFinalMessageSeparator || !state.hadWorkActivity || !mode.chatContainer) {
		return false;
	}

	const separator = new WorkFinalSeparatorComponent(getSeparatorElapsedSeconds(mode, nowMs));
	const children = mode.chatContainer.children;
	const streamingComponent = mode.streamingComponent;
	const insertIndex =
		Array.isArray(children) && streamingComponent !== undefined
			? children.indexOf(streamingComponent)
			: -1;
	if (Array.isArray(children) && insertIndex >= 0) {
		children.splice(insertIndex, 0, separator);
	} else {
		mode.chatContainer.addChild(separator);
	}
	state.lastSeparatorAtMs = nowMs;
	state.needsFinalMessageSeparator = false;
	state.hadWorkActivity = false;
	return true;
}

function renderWorkingTimerState(
	mode: PatchableInteractiveModeInstance,
	state: WorkingTimerState,
	nowMs = Date.now(),
): void {
	state.originalSetMessage(
		formatWorkingStatusMessage(
			state.rawMessage,
			state.startedAtMs,
			getInterruptKeyLabel(),
			nowMs,
		),
	);
}

function detachWorkingTimer(mode: PatchableInteractiveModeInstance): void {
	const state = mode[WORKING_TIMER_STATE_KEY];
	if (!state) {
		return;
	}

	if (state.interval) {
		clearInterval(state.interval);
	}

	state.loader.setMessage = state.originalSetMessage;
	state.loader.stop = state.originalStop;
	delete mode[WORKING_TIMER_STATE_KEY];
}

function attachWorkingTimer(mode: PatchableInteractiveModeInstance): void {
	const loader = mode.loadingAnimation;
	if (!isLoaderLike(loader)) {
		detachWorkingTimer(mode);
		return;
	}

	const existing = mode[WORKING_TIMER_STATE_KEY];
	if (existing?.loader === loader) {
		renderWorkingTimerState(mode, existing);
		return;
	}

	detachWorkingTimer(mode);

	const state: WorkingTimerState = {
		loader,
		originalSetMessage: loader.setMessage.bind(loader),
		originalStop: loader.stop.bind(loader),
		rawMessage: normalizeWorkingStatusLabel(loader.message, mode.defaultWorkingMessage),
		startedAtMs: Date.now(),
	};

	loader.setMessage = (message: string): void => {
		state.rawMessage = normalizeWorkingStatusLabel(message, mode.defaultWorkingMessage);
		renderWorkingTimerState(mode, state);
	};
	loader.stop = (): void => {
		detachWorkingTimer(mode);
		state.originalStop();
	};

	state.interval = setInterval(() => {
		if (mode.loadingAnimation !== loader) {
			detachWorkingTimer(mode);
			return;
		}

		renderWorkingTimerState(mode, state);
	}, 1000);

	mode[WORKING_TIMER_STATE_KEY] = state;
	renderWorkingTimerState(mode, state);
}

export function patchInteractiveWorkingTimer(): void {
	const prototype = InteractiveMode.prototype as unknown as PatchableInteractiveModePrototype;
	if (
		prototype.__piToolViewWorkingTimerPatchVersion === WORKING_TIMER_PATCH_VERSION
		&& prototype.__piToolViewWorkingTimerOriginalHandleEvent
		&& prototype.__piToolViewWorkingTimerOriginalStop
	) {
		return;
	}

	if (!prototype.__piToolViewWorkingTimerOriginalHandleEvent) {
		prototype.__piToolViewWorkingTimerOriginalHandleEvent = prototype.handleEvent;
	}
	if (!prototype.__piToolViewWorkingTimerOriginalStop) {
		prototype.__piToolViewWorkingTimerOriginalStop = prototype.stop;
	}

	const originalHandleEvent = prototype.__piToolViewWorkingTimerOriginalHandleEvent;
	const originalStop = prototype.__piToolViewWorkingTimerOriginalStop;
	if (!originalHandleEvent || !originalStop) {
		return;
	}

	prototype.handleEvent = async function patchedHandleEvent(event: unknown): Promise<unknown> {
		const mode = this as unknown as PatchableInteractiveModeInstance;
		const eventType =
			typeof event === "object" && event !== null && "type" in event
				? (event as { type?: unknown }).type
				: undefined;

		if (eventType === "agent_start") {
			detachWorkingTimer(mode);
			resetWorkTurnState(mode);
		} else if (eventType === "message_update") {
			if (hasVisibleAssistantTextDelta(event)) {
				insertWorkSeparator(mode);
			} else if (isToolCallAssistantUpdate(event)) {
				// Explicitly ignore tool-call deltas so the divider only appears
				// when the assistant actually starts narrating.
			}
		} else if (eventType === "message_end") {
			if (hasVisibleAssistantText(event) && !hasAssistantToolCalls(event)) {
				insertWorkSeparator(mode);
			}
		}

		const result = await originalHandleEvent.call(this, event);

		if (eventType === "agent_start") {
			attachWorkingTimer(mode);
		} else if (eventType === "tool_execution_end") {
			const toolName =
				typeof event === "object" && event !== null && "toolName" in event
					? (event as { toolName?: unknown }).toolName
					: undefined;
			if (shouldInsertSeparatorAfterTool(toolName)) {
				const state = getOrCreateWorkTurnState(mode);
				state.hadWorkActivity = true;
				state.needsFinalMessageSeparator = true;
			}
		} else if (eventType === "agent_end") {
			detachWorkingTimer(mode);
		}

		return result;
	};

	prototype.stop = function patchedStop(): void {
		detachWorkingTimer(this as unknown as PatchableInteractiveModeInstance);
		delete (this as PatchableInteractiveModeInstance)[WORK_TURN_STATE_KEY];
		return originalStop.call(this);
	};

	prototype.__piToolViewWorkingTimerPatchVersion = WORKING_TIMER_PATCH_VERSION;
}
