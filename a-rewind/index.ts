import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXT = "a-rewind";

type NotifyLevel = "info" | "warning" | "error";

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

export default function aRewind(pi: ExtensionAPI) {
	pi.registerCommand("a-rewind-last", {
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
