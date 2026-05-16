// Win Bash Sanitizer — sanitizes bash tool calls for Git Bash on Windows.
// Fixes: Windows paths with spaces, cmd fallbacks (|| dir), 2>nul, broken quotes,
// cmd commands (dir/copy/del/etc.), backslash escapes, env vars.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// Windows utilities we do NOT remap — leave arguments untouched
// (except nul redirects and env vars, which are fixed globally).
const WINDOWS_UTILS = new Set([
	"findstr", "ping", "tasklist", "ipconfig", "systeminfo", "net", "sc",
	"reg", "wmic", "schtasks", "certutil", "cipher", "compact", "diskpart",
	"driverquery", "fc", "fsutil", "getmac", "nbtstat", "nslookup", "pathping",
	"qprocess", "qwinsta", "robocopy", "rwinsta", "shutdown", "subst", "tree",
	"ver", "vol", "whoami", "chkdsk", "format", "label", "convert", "attrib",
	"cacls", "icacls", "takeown", "logman", "openfiles", "perfmon", "powershell",
	"cmd", "cmd.exe", "start",
]);

// Commands we actively map to bash equivalents.
const MAPPED_CMDS = new Set([
	"dir", "copy", "move", "del", "ren", "type", "cls", "more", "xcopy", "echo.", "cd",
]);

export default function (pi: ExtensionAPI) {
	if (process.platform !== "win32") return;

	// Lightweight ephemeral hint for the LLM (does not bloat the system prompt)
	pi.on("before_agent_start", async () => ({
		message: {
			customType: "win-bash-rules",
			content: [
				"You are on Windows with Git Bash.",
				"Path rules: use '/c/...' instead of 'C:\\\\'. Wrap spaced paths in SINGLE quotes.",
				"Redirection: use '2>/dev/null', never '2>nul'.",
				"Listing: use 'ls', never 'dir'. Do NOT use '|| dir ...' fallbacks.",
				"Never end a quoted path with backslash: WRONG: \"C:\\\\dir\\\\\"  RIGHT: '/c/dir'",
				"Use bash commands (cp, mv, rm, cat) instead of Windows commands (copy, move, del, type).",
			].join("\n"),
			display: false,
		},
	}));

	// Intercept and sanitize bash commands
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const original: string = event.input.command;
		let cmd = original;
		let modified = false;

		// Rule A: strip cmd fallback "|| dir ..."
		const fallbackMatch = cmd.match(/^(.*?)\s*\|\|\s*dir\b.*$/i);
		if (fallbackMatch) {
			cmd = fallbackMatch[1].trim();
			modified = true;
		}

		// Rule B: replace nul redirects (always — safe because we anchor on the > operator)
		const nulRedirectRegex = /(\d*>>?)\s*nul\b/gi;
		if (nulRedirectRegex.test(cmd)) {
			cmd = cmd.replace(nulRedirectRegex, "$1/dev/null");
			modified = true;
		}

		// Rule C: replace env vars %VAR% -> $VAR (always)
		const envFixed = fixEnvVars(cmd);
		if (envFixed !== cmd) {
			cmd = envFixed;
			modified = true;
		}

		// Rule D: process compound commands (&&, ||, ;)
		const chainFixed = processCommandChain(cmd);
		if (chainFixed !== cmd) {
			cmd = chainFixed;
			modified = true;
		}

		if (modified) {
			event.input.command = cmd;
			ctx.ui?.notify?.(`Git Bash fix: ${original} → ${cmd}`, "info");
		}

		// Rule E: quote balance check (blocks only genuinely broken commands)
		if (hasUnbalancedQuotes(cmd)) {
			return {
				block: true,
				reason: `Quote mismatch after sanitization. Command: ${cmd}\nPlease rewrite using single quotes for Windows paths.`,
			};
		}
	});
}

// ── Helpers ──

/** Split a string into shell-like arguments respecting single/double quotes. */
function splitArgs(str: string): string[] {
	const args: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			current += c;
		} else if (c === '"' && !inSingle) {
			inDouble = !inDouble;
			current += c;
		} else if (/\s/.test(c) && !inSingle && !inDouble) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += c;
		}
	}
	if (current) args.push(current);
	return args;
}

/** Process command chains (&&, ||, ;) applying mappings per segment. */
function processCommandChain(cmd: string): string {
	const parts = cmd.split(/(\s*&&\s*|\s*\|\|\s*|\s*;\s*)/);
	return parts
		.map((part) => {
			const trimmed = part.trim();
			if (!trimmed || /^(&&|\|\||;)$/.test(trimmed)) return part;

			const firstToken = trimmed.split(/\s+/)[0].toLowerCase();
			if (WINDOWS_UTILS.has(firstToken)) {
				return part;
			}

			const mapped = applyMapping(trimmed);
			if (mapped !== trimmed) return mapped;

			// Bash command with potential Windows artifacts
			let fixed = fixWindowsPaths(trimmed);
			fixed = fixBackslashes(fixed);
			if (fixed !== trimmed) return fixed;
			return part;
		})
		.join("");
}

/** Map known cmd commands to bash equivalents. Only touches the start of the command. */
function applyMapping(cmd: string): string {
	const tokens = splitArgs(cmd);
	const first = tokens[0].toLowerCase();

	// cd /d
	if (first === "cd" && tokens[1]?.toLowerCase() === "/d") {
		return "cd " + tokens.slice(2).map(toBashPath).join(" ");
	}

	// cls
	if (first === "cls") return "clear";

	// echo.
	if (first === "echo.") return "echo" + cmd.trim().slice(5);

	// dir
	if (first === "dir") {
		const rest = tokens.slice(1);
		const bIndex = rest.findIndex((a) => a.toLowerCase() === "/b");
		const hasB = bIndex >= 0;
		if (hasB) rest.splice(bIndex, 1);
		const paths = rest.map(toBashPath).join(" ");
		if (hasB) return paths ? `ls -1 ${paths}` : "ls -1";
		return paths ? `ls ${paths}` : "ls";
	}

	// copy
	if (first === "copy") {
		return "cp " + tokens.slice(1).map(toBashPath).join(" ");
	}

	// move
	if (first === "move") {
		return "mv " + tokens.slice(1).map(toBashPath).join(" ");
	}

	// del
	if (first === "del") {
		return "rm " + tokens.slice(1).map(toBashPath).join(" ");
	}

	// ren -> mv with same-directory target
	if (first === "ren") {
		const args = tokens.slice(1).map(toBashPath);
		if (args.length >= 2) {
			const src = args[0];
			const dst = args[1];
			const dstRaw = extractRawPath(dst);
			if (!dstRaw.includes("/")) {
				const srcRaw = extractRawPath(src);
				const lastSlash = srcRaw.lastIndexOf("/");
				const dir = lastSlash >= 0 ? srcRaw.slice(0, lastSlash + 1) : "";
				return `mv ${src} ${toBashPath(dir + dstRaw)}`;
			}
			return `mv ${src} ${dst}`;
		}
		return "mv " + args.join(" ");
	}

	// type
	if (first === "type") {
		return "cat " + tokens.slice(1).map(toBashPath).join(" ");
	}

	// more
	if (first === "more") {
		return "less " + tokens.slice(1).map(toBashPath).join(" ");
	}

	// xcopy
	if (first === "xcopy") {
		return "cp -r " + tokens.slice(1).map(toBashPath).join(" ");
	}

	return cmd;
}

/** Convert %VAR% to $VAR. */
function fixEnvVars(cmd: string): string {
	return cmd.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => `$${name}`);
}

/** Convert C:\ style paths to /c/ style. Handles quoted and unquoted forms. */
function fixWindowsPaths(cmd: string): string {
	// 1. Double-quoted paths: "C:\foo\bar" or "C:\foo bar\baz"
	cmd = cmd.replace(/"([A-Za-z]:\\(?:[^"]|\\.)*)"/g, (_match, inner) => {
		let p = inner
			.replace(/\\"/g, '"')
			.replace(/\\/g, "/")
			.replace(/^([A-Za-z]):\//, (_m: string, drive: string) => `/${drive.toLowerCase()}/`);
		p = p.replace(/\/$/, ""); // strip trailing /
		if (p.includes(" ")) return `'${p}'`;
		return p;
	});

	// 2. Unquoted paths: tokens starting with C:\ (with \-escaped spaces inside)
	let result = "";
	let i = 0;
	while (i < cmd.length) {
		const m = cmd.slice(i).match(/^([A-Za-z]):\\((?:[^ \t\n\r"']|\\.)+)/);
		if (m) {
			let p = m[0]
				.replace(/\\([ \t\n\r"'])/g, "$1")
				.replace(/\\/g, "/")
				.replace(/^([A-Za-z]):\//, (_m: string, drive: string) => `/${drive.toLowerCase()}/`);
			p = p.replace(/\/$/, "");
			result += p.includes(" ") ? `'${p}'` : p;
			i += m[0].length;
		} else {
			result += cmd[i];
			i++;
		}
	}
	return result;
}

/** Remove backslash escapes before ordinary characters (not inside single quotes). */
function fixBackslashes(cmd: string): string {
	return cmd.replace(/\\([^\s"'\\])/g, (match, char, offset) => {
		const before = cmd.slice(0, offset);
		const quotes = before.match(/'/g);
		if (quotes && quotes.length % 2 !== 0) return match; // inside single quotes
		return char;
	});
}

/** Strip surrounding quotes from a path expression. */
function extractRawPath(expr: string): string {
	let p = expr.trim();
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		p = p.slice(1, -1);
	}
	return p;
}

/** Normalize a path expression for bash: lowercase drive, forward slashes, single quotes if needed. */
function toBashPath(expr: string): string {
	let p = expr.trim();
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		p = p.slice(1, -1);
	}
	p = p
		.replace(/\\/g, "/")
		.replace(/^([A-Za-z]):\//, (_m, drive) => `/${drive.toLowerCase()}/`)
		.replace(/\/$/, "");
	if (p.includes(" ")) return `'${p}'`;
	return p;
}

/** Check for unbalanced quotes, respecting backslash escapes. */
function hasUnbalancedQuotes(cmd: string): boolean {
	let dbl = 0;
	let sgl = 0;
	let escaped = false;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (c === "\\") {
			escaped = true;
			continue;
		}
		if (c === '"') dbl++;
		if (c === "'") sgl++;
	}
	return dbl % 2 !== 0 || sgl % 2 !== 0;
}
