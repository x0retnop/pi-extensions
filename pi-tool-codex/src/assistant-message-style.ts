import { AssistantMessageComponent, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { MarkdownTheme } from "@mariozechner/pi-tui";
import { applyConversationInterruptedLabel } from "./interruption-label.js";

const ASSISTANT_HEADING_FOREGROUND = "\x1b[38;2;255;255;255m";
const ASSISTANT_MARKDOWN_ACCENT_FOREGROUND = "\x1b[38;2;138;190;183m";
const ANSI_FOREGROUND_RESET = "\x1b[39m";
const OSC133_SEQUENCE_PATTERN = /\x1b]133;[ABC]\x07/g;
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ASSISTANT_MESSAGE_PATCH_VERSION = 5;

type AssistantUpdateContentFn = (message: unknown) => void;
type AssistantRenderFn = (width: number) => string[];

interface PatchableAssistantMessagePrototype {
	updateContent: AssistantUpdateContentFn;
	render?: AssistantRenderFn;
	__piAssistantMessageOriginalUpdateContent?: AssistantUpdateContentFn;
	__piAssistantMessageOriginalRender?: AssistantRenderFn;
	__piAssistantMessagePatchVersion?: number;
}

interface PatchableAssistantMessageInstance {
	markdownTheme?: MarkdownTheme;
	__piAssistantMessageBaseMarkdownTheme?: MarkdownTheme;
	__piAssistantMessageWrappedMarkdownTheme?: MarkdownTheme;
}

function createAssistantMarkdownTheme(baseTheme: MarkdownTheme): MarkdownTheme {
	return {
		...baseTheme,
		heading: (text: string): string =>
			`${ASSISTANT_HEADING_FOREGROUND}${text}${ANSI_FOREGROUND_RESET}`,
		code: (text: string): string =>
			`${ASSISTANT_MARKDOWN_ACCENT_FOREGROUND}${text}${ANSI_FOREGROUND_RESET}`,
		listBullet: (text: string): string =>
			`${ASSISTANT_MARKDOWN_ACCENT_FOREGROUND}${text}${ANSI_FOREGROUND_RESET}`,
	};
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function stripAssistantControlSequences(text: string): string {
	return text.replace(OSC133_SEQUENCE_PATTERN, "");
}

function isBlankRenderedLine(text: string): boolean {
	return stripAnsi(stripAssistantControlSequences(text)).trim().length === 0;
}

function startsWithMarkdownListMarker(text: string): boolean {
	return /^\s*(?:[-*+]|\d+\.)\s/.test(stripAnsi(stripAssistantControlSequences(text)));
}

function compactAssistantRenderLines(lines: string[]): string[] {
	const cleaned = lines.map((line) => stripAssistantControlSequences(line));
	const compacted: string[] = [];

	for (let index = 0; index < cleaned.length; index++) {
		const line = cleaned[index] ?? "";
		const blank = isBlankRenderedLine(line);

		if (blank) {
			const previousVisible = [...compacted].reverse().find((candidate) => !isBlankRenderedLine(candidate));
			const nextVisible = cleaned.slice(index + 1).find((candidate) => !isBlankRenderedLine(candidate));
			if (!previousVisible || !nextVisible) {
				continue;
			}
			if (isBlankRenderedLine(compacted[compacted.length - 1] ?? "")) {
				continue;
			}
			if (startsWithMarkdownListMarker(nextVisible)) {
				continue;
			}
		}

		compacted.push(line);
	}

	return compacted;
}

function cleanMarkdownSymbols(lines: string[]): string[] {
	return lines.map((line) => {
		const plain = stripAnsi(line);

		if (/^\s*```\w*\s*$/.test(plain)) {
			return "";
		}

		if (/^#{1,6}\s+/.test(plain)) {
			const hashes = plain.match(/^(#{1,6})/)?.[0]?.length ?? 0;
			line = line.replace(/#{1,6}\s+/, " ".repeat(hashes) + "  ");
		}

		line = line.replace(/`([^`]+)`/g, "$1");
		line = line.replace(/\*\*([^*]+)\*\*/g, "$1");
		line = line.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");

		line = line.replace(
			/^(\s*)(?:\x1b\[[0-9;?]*[ -/]*[@-~])*[-*+](?:\x1b\[[0-9;?]*[ -/]*[@-~])*\s+/,
			"$1  ",
		);

		return line;
	});
}

function ensureAssistantMarkdownTheme(instance: PatchableAssistantMessageInstance): void {
	const baseTheme = instance.markdownTheme;
	if (!baseTheme) {
		return;
	}

	if (instance.__piAssistantMessageBaseMarkdownTheme === baseTheme && instance.__piAssistantMessageWrappedMarkdownTheme) {
		instance.markdownTheme = instance.__piAssistantMessageWrappedMarkdownTheme;
		return;
	}

	instance.__piAssistantMessageBaseMarkdownTheme = baseTheme;
	instance.__piAssistantMessageWrappedMarkdownTheme = createAssistantMarkdownTheme(baseTheme);
	instance.markdownTheme = instance.__piAssistantMessageWrappedMarkdownTheme;
}

export function patchAssistantMessagePrototype(
	prototype: PatchableAssistantMessagePrototype,
): void {
	if (typeof prototype.updateContent !== "function") {
		return;
	}

	if (
		prototype.__piAssistantMessagePatchVersion === ASSISTANT_MESSAGE_PATCH_VERSION
		&& typeof prototype.__piAssistantMessageOriginalUpdateContent === "function"
	) {
		return;
	}

	if (!prototype.__piAssistantMessageOriginalUpdateContent) {
		prototype.__piAssistantMessageOriginalUpdateContent = prototype.updateContent;
	}
	if (!prototype.__piAssistantMessageOriginalRender && typeof prototype.render === "function") {
		prototype.__piAssistantMessageOriginalRender = prototype.render;
	}

	const originalUpdateContent = prototype.__piAssistantMessageOriginalUpdateContent;
	const originalRender = prototype.__piAssistantMessageOriginalRender;
	if (!originalUpdateContent) {
		return;
	}

	prototype.updateContent = function patchedUpdateContent(message: unknown): void {
		ensureAssistantMarkdownTheme(this as PatchableAssistantMessageInstance);
		applyConversationInterruptedLabel(message);
		return originalUpdateContent.call(this, message);
	};
	if (originalRender) {
		prototype.render = function patchedRender(width: number): string[] {
			return compactAssistantRenderLines(cleanMarkdownSymbols(originalRender.call(this, width)));
		};
	}
	prototype.__piAssistantMessagePatchVersion = ASSISTANT_MESSAGE_PATCH_VERSION;
}

export function registerAssistantMessageStyling(pi: ExtensionAPI): void {
	patchAssistantMessagePrototype(
		(AssistantMessageComponent as unknown as { prototype: PatchableAssistantMessagePrototype }).prototype,
	);

	pi.on("before_agent_start", async () => {
		patchAssistantMessagePrototype(
			(AssistantMessageComponent as unknown as { prototype: PatchableAssistantMessagePrototype }).prototype,
		);
	});
}
