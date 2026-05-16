import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface AssistantContentLike {
	type?: unknown;
}

interface AssistantMessageLike {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	content?: unknown;
}

const INTERRUPTION_LABEL_COLOR = "\x1b[38;2;215;89;89m";
const INTERRUPTION_LABEL_RESET = "\x1b[39m";
const INTERRUPTION_LABEL_TEXT = "■ Conversation interrupted";
const REQUEST_ABORTED_ERROR = "Request was aborted";
const REQUEST_ABORTED_ERROR_WITH_PERIOD = "Request was aborted.";
const OPERATION_ABORTED_ERROR = "Operation aborted";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasToolCalls(content: unknown): boolean {
	return Array.isArray(content)
		&& content.some(
			(block): block is AssistantContentLike =>
				isRecord(block) && block.type === "toolCall",
		);
}

function isAbortableAssistantMessage(
	message: unknown,
): message is AssistantMessageLike {
	return isRecord(message)
		&& message.role === "assistant"
		&& (
			message.stopReason === "aborted"
			|| (
				message.stopReason === "error"
				&& isDefaultAbortMessage(message.errorMessage)
			)
		)
		&& !hasToolCalls(message.content);
}

export function formatConversationInterruptedLabel(): string {
	return `${INTERRUPTION_LABEL_COLOR}${INTERRUPTION_LABEL_TEXT}${INTERRUPTION_LABEL_RESET}`;
}

export function getConversationInterruptedText(): string {
	return INTERRUPTION_LABEL_TEXT;
}

export function isDefaultAbortMessage(message: unknown): boolean {
	if (typeof message !== "string") {
		return false;
	}

	const normalized = message.trim();
	return normalized === REQUEST_ABORTED_ERROR
		|| normalized === REQUEST_ABORTED_ERROR_WITH_PERIOD
		|| normalized === OPERATION_ABORTED_ERROR
		|| normalized === INTERRUPTION_LABEL_TEXT
		|| normalized === formatConversationInterruptedLabel();
}

export function applyConversationInterruptedLabel(message: unknown): boolean {
	if (!isAbortableAssistantMessage(message)) {
		return false;
	}

	const nextErrorMessage = formatConversationInterruptedLabel();
	if (message.errorMessage === nextErrorMessage) {
		return false;
	}

	if (
		typeof message.errorMessage === "string"
		&& message.errorMessage.trim().length > 0
		&& !isDefaultAbortMessage(message.errorMessage)
	) {
		return false;
	}

	message.errorMessage = nextErrorMessage;
	return true;
}

export function registerInterruptionLabeling(pi: ExtensionAPI): void {
	pi.on("message_update", async (event) => {
		if (!isRecord(event)) {
			return;
		}

		applyConversationInterruptedLabel(event.message);
	});

	pi.on("message_end", async (event) => {
		if (!isRecord(event)) {
			return;
		}

		applyConversationInterruptedLabel(event.message);
	});
}
