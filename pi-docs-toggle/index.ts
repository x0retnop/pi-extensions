import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXT = "pi-docs-toggle";

/** Whether the Pi documentation block is enabled in the system prompt.
 *  Default: false (stripped) — survives only for the current session. */
let piDocsEnabled = false;

/** Guard: only warn once per session if regex fails to strip the block. */
let regexWarnedThisSession = false;

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
	const text = message.startsWith(`[${EXT}]`) ? message : `[${EXT}] ${message}`;
	try {
		if (ctx?.hasUI && typeof ctx.ui?.notify === "function") {
			ctx.ui.notify(text, level);
		}
	} catch {
		// Never write extension diagnostics to stdout/stderr.
	}
}

/** Attempt 1: exact match for the current known block shape. */
function stripExact(prompt: string): string {
	return prompt.replace(
		/\n\nPi documentation[\s\S]*?Always read pi \.md files completely and follow links to related docs[^\n]*(?:\n|$)/,
		"",
	);
}

/** Attempt 2: soft fallback — anything between "Pi documentation" header and the last known bullet area. */
function stripFallback(prompt: string): string {
	return prompt.replace(
		/\n\nPi documentation[\s\S]*?(?:- Always read pi[^\n]*\n?|- When working on pi topics[^\n]*\n?)+/,
		"",
	);
}

function stripPiDocs(prompt: string): { cleaned: string; delta: number } {
	const exact = stripExact(prompt);
	if (exact.length !== prompt.length) {
		return { cleaned: exact, delta: prompt.length - exact.length };
	}

	const fallback = stripFallback(prompt);
	return { cleaned: fallback, delta: prompt.length - fallback.length };
}

export default function piDocsToggleExtension(pi: ExtensionAPI) {
	pi.on("session_start", () => {
		// Reset warning flag on every new / resumed / forked session
		regexWarnedThisSession = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const { systemPrompt } = event;
		if (piDocsEnabled) return undefined;

		const { cleaned, delta } = stripPiDocs(systemPrompt);

		// Self-check: if nothing was stripped but the block signature is still present,
		// the hard-coded text probably changed in a new pi version.
		if (
			delta === 0 &&
			systemPrompt.includes("Pi documentation") &&
			!regexWarnedThisSession
		) {
			regexWarnedThisSession = true;
			notify(
				ctx,
				"Warning: Pi documentation block detected but could not be stripped. The regex may need updating for this pi version.",
				"warning",
			);
		}

		return { systemPrompt: cleaned };
	});

	pi.registerCommand("pi_docs", {
		description:
			"Toggle the Pi documentation block in the system prompt (cycle: off → on → off). Session-only, not persisted.",
		handler: async (_args: string, ctx: any) => {
			try {
				piDocsEnabled = !piDocsEnabled;
				const state = piDocsEnabled ? "ON" : "OFF";
				notify(ctx, `Pi documentation block is now ${state} for this session.`, "info");
			} catch (err) {
				notify(ctx, formatError(err), "error");
			}
		},
	});
}
