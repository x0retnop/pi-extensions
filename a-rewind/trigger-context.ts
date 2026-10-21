export const WARM_TRIGGER = "a-warm-trigger";
export const RETRY_TRIGGER = "a-retry-trigger";
export const WARM_USER_TEXT = "Reply with exactly: ok. Do not use tools.";

export type TriggerContextMessage = {
	role?: string;
	customType?: string;
	content?: unknown;
	timestamp?: number;
	[key: string]: unknown;
};

function isWarmTrigger(m: TriggerContextMessage): boolean {
	return m.role === "custom" && m.customType === WARM_TRIGGER;
}

function isRetryTrigger(m: TriggerContextMessage): boolean {
	return m.role === "custom" && m.customType === RETRY_TRIGGER;
}

/**
 * Strip /retry and /warm markers from the LLM context.
 *
 * Warm is a one-shot cache ping. Inject WARM_USER_TEXT only when the last
 * message is the warm trigger (this turn *is* the ping). On later turns drop
 * each warm trigger and the reply that followed it (assistant / tool results
 * until the next user), so the "do not use tools" cue cannot stick.
 *
 * Retry: drop markers; if that leaves an assistant at the end, append " "
 * for role alternation.
 */
export function applyTriggerContext(
	messages: readonly TriggerContextMessage[],
): TriggerContextMessage[] | undefined {
	if (!Array.isArray(messages) || messages.length === 0) return undefined;

	const last = messages[messages.length - 1];
	const isWarmTurn = isWarmTrigger(last);
	let sawRetry = false;
	let stripped = false;
	const cleaned: TriggerContextMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (isRetryTrigger(m)) {
			sawRetry = true;
			stripped = true;
			continue;
		}
		if (isWarmTrigger(m)) {
			stripped = true;
			if (isWarmTurn && i === messages.length - 1) break;
			while (i + 1 < messages.length) {
				const n = messages[i + 1];
				if (n.role === "user") break;
				if (isWarmTrigger(n) || isRetryTrigger(n)) break;
				i++;
			}
			continue;
		}
		cleaned.push(m);
	}

	if (isWarmTurn) {
		cleaned.push({
			role: "user",
			content: WARM_USER_TEXT,
			timestamp: Date.now(),
		});
		return cleaned;
	}

	if (!stripped) return undefined;

	if (
		sawRetry &&
		cleaned.length > 0 &&
		cleaned[cleaned.length - 1].role === "assistant"
	) {
		cleaned.push({
			role: "user",
			content: " ",
			timestamp: Date.now(),
		});
	}

	return cleaned;
}
