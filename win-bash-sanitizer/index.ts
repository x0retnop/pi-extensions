// Win Bash Sanitizer — sanitizes bash tool calls for Git Bash on Windows.
// Fixes: Windows paths with spaces, cmd fallbacks (|| dir), 2>nul, broken quotes,
// cmd commands (dir/copy/del/etc.), backslash escapes, env vars.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const WINDOWS_UTILS = new Set([
	"findstr", "ping", "tasklist", "ipconfig", "systeminfo", "net", "sc",
	"reg", "wmic", "schtasks", "certutil", "cipher", "compact", "diskpart",
	"driverquery", "fc", "fsutil", "getmac", "nbtstat", "nslookup", "pathping",
	"qprocess", "qwinsta", "robocopy", "rwinsta", "shutdown", "subst", "tree",
	"ver", "vol", "whoami", "chkdsk", "format", "label", "convert", "attrib",
	"cacls", "icacls", "takeown", "logman", "openfiles", "perfmon", "powershell",
	"cmd", "cmd.exe", "start",
]);

const MAPPED_CMDS = new Set([
	"dir", "copy", "move", "del", "ren", "type", "cls", "more", "xcopy", "echo.", "cd",
]);

export default function (pi: ExtensionAPI) {
	if (process.platform !== "win32") return;

	pi.on("before_agent_start", async () => ({
		message: {
			customType: "win-bash-rules",
			content: [
				"You are on Windows with Git Bash.",
				"Redirection: use '2>/dev/null', never '2>nul'.",
				"Listing: use 'ls', never 'dir'. Do NOT use '|| dir ...' fallbacks.",
				"Use bash commands (cp, mv, rm, cat) instead of Windows commands (copy, move, del, type).",
			].join("\n"),
			display: false,
		},
	}));

	pi.on("tool_call", async (event, ctx) => {
		// Fix bash-style /c/... paths in read/write/edit tools.
		// Pi tools use various property names for the file path.
		const pathKeys = ["path", "filePath", "filepath", "targetPath", "file", "target", "filename"] as const;
		for (const key of pathKeys) {
			if (event.input && typeof event.input[key] === "string") {
				const originalPath = event.input[key];
				const fixedPath = fixBashPathToWindows(originalPath);
				if (fixedPath !== originalPath) {
					event.input[key] = fixedPath;
					ctx.ui?.notify?.(`Path fix: ${originalPath} → ${fixedPath}`, "info");
				}
			}
		}

		if (!isToolCallEventType("bash", event)) return;

		const original: string = event.input.command;
		let modified = false;

		// Isolate heredoc body — never touch data inside it.
		const heredocIdx = original.search(/<<['"]?[A-Z_][A-Z0-9_]*['"]?/i);
		const shell = heredocIdx >= 0 ? original.slice(0, heredocIdx) : original;
		const body = heredocIdx >= 0 ? original.slice(heredocIdx) : "";
		let working = shell;

		// Rule A: strip cmd fallback "|| dir ..."
		const dirFallbackRegex = /\s*\|\|\s*dir(?:\s+\S+)*\s*/gi;
		if (dirFallbackRegex.test(working)) {
			working = working.replace(dirFallbackRegex, " ").trim();
			modified = true;
		}

		// Rule B: replace nul redirects
		const nulRedirectRegex = /(\d*>>?)\s*nul\b/gi;
		if (nulRedirectRegex.test(working)) {
			working = working.replace(nulRedirectRegex, "$1/dev/null");
			modified = true;
		}

		// Rule C: replace env vars %VAR% -> $VAR
		const envFixed = fixEnvVars(working);
		if (envFixed !== working) {
			working = envFixed;
			modified = true;
		}

		// Rule D: process compound commands (&&, ||, ;)
		const chainFixed = processCommandChain(working);
		if (chainFixed !== working) {
			working = chainFixed;
			modified = true;
		}

		const cmd = working + body;
		if (modified) {
			event.input.command = cmd;
			ctx.ui?.notify?.(`Git Bash fix: ${original} → ${cmd}`, "info");
		}

		// Rule E: quote balance check (shell syntax only)
		if (hasUnbalancedQuotes(working)) {
			return {
				block: true,
				reason: `Quote mismatch after sanitization. Command: ${cmd}\nPlease rewrite using single quotes for Windows paths.`,
			};
		}
	});
}

function fixBashPathToWindows(p: string): string {
	return p.replace(/^\/([a-z])\//i, "$1:/");
}

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
			if (current) { args.push(current); current = ""; }
		} else {
			current += c;
		}
	}
	if (current) args.push(current);
	return args;
}

function stripWindowsFlags(tokens: string[]): string[] {
	return tokens.filter((t) => !/^\/[A-Za-z]+$/.test(t));
}

/** Commands whose quoted arguments contain inline code, not bash paths. */
const INLINE_INTERPRETERS = new Set(["python", "python3", "py", "node", "nodejs"]);

function hasInlineFlag(tokens: string[]): boolean {
	return tokens.some((t) => t === "-c" || t === "-e" || t === "--eval" || t === "-exec");
}

function processCommandChain(cmd: string): string {
	const parts = cmd.split(/(\s*&&\s*|\s*\|\|\s*|\s*;\s*)/);
	return parts
		.map((part) => {
			const trimmed = part.trim();
			if (!trimmed || /^(&&|\|\||;)$/.test(trimmed)) return part;

			const tokens = splitArgs(trimmed);
			const firstToken = tokens[0].toLowerCase();
			if (WINDOWS_UTILS.has(firstToken)) return part;

			// Do not convert Windows paths inside inline script arguments
			// (e.g. python -c "p = r'C:\foo'" → Python needs C:\, not /c/).
			const isInlineScript = INLINE_INTERPRETERS.has(firstToken) && hasInlineFlag(tokens);

			let fixed = isInlineScript ? trimmed : fixWindowsPaths(trimmed);
			fixed = fixBackslashes(fixed);
			const working = fixed !== trimmed ? fixed : trimmed;

			const mapped = applyMapping(working);
			if (mapped !== working) return part.replace(trimmed, mapped);
			if (fixed !== trimmed) return part.replace(trimmed, fixed);
			return part;
		})
		.join("");
}

function applyMapping(cmd: string): string {
	const tokens = splitArgs(cmd);
	const first = tokens[0].toLowerCase();

	if (first === "cd" && tokens[1]?.toLowerCase() === "/d") {
		return "cd " + tokens.slice(2).map(toBashPath).join(" ");
	}
	if (first === "cls") return "clear";
	if (first === "echo.") {
		const rest = cmd.trim().slice(5);
		return "echo" + (rest ? " " + rest : "");
	}
	if (first === "dir") {
		const rest = tokens.slice(1);
		const bIndex = rest.findIndex((a) => a.toLowerCase() === "/b");
		const hasB = bIndex >= 0;
		if (hasB) rest.splice(bIndex, 1);
		const paths = rest.map(toBashPath).join(" ");
		if (hasB) return paths ? `ls -1 ${paths}` : "ls -1";
		return paths ? `ls ${paths}` : "ls";
	}
	if (first === "copy") return "cp " + stripWindowsFlags(tokens.slice(1)).map(toBashPath).join(" ");
	if (first === "move") return "mv " + stripWindowsFlags(tokens.slice(1)).map(toBashPath).join(" ");
	if (first === "del") return "rm " + stripWindowsFlags(tokens.slice(1)).map(toBashPath).join(" ");
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
	if (first === "type") return "cat " + tokens.slice(1).map(toBashPath).join(" ");
	if (first === "more") return "less " + tokens.slice(1).map(toBashPath).join(" ");
	if (first === "xcopy") return "cp -r " + stripWindowsFlags(tokens.slice(1)).map(toBashPath).join(" ");
	return cmd;
}

function fixEnvVars(cmd: string): string {
	return cmd.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => `$${name}`);
}

function fixWindowsPaths(cmd: string): string {
	const fixDrive = (p: string) =>
		p
			.replace(/([A-Za-z]):\\([a-z])\\/g, (_m, drive, letter) =>
				drive.toLowerCase() === letter ? `/${letter}/` : _m
			)
			.replace(/^([A-Za-z]):[/\\]/, (_m: string, drive: string) => `/${drive.toLowerCase()}/`);

	cmd = cmd.replace(/"([A-Za-z]:\\(?:[^"]|\\.)*)"/g, (_match, inner) => {
		let p = inner.replace(/\\"/g, '"').replace(/\/$/, "");
		p = fixDrive(p).replace(/\\/g, "/");
		if (p.includes(" ")) return `'${p}'`;
		return p;
	});

	let result = "";
	let i = 0;
	while (i < cmd.length) {
		const m = cmd.slice(i).match(/^([A-Za-z]):\\((?:[^"']|\\.)+)/);
		if (m) {
			let pathEnd = i + m[0].length;
			while (true) {
				const rest = cmd.slice(pathEnd);
				if (/^\s*(&&|\|\||;|\|>|>>|>|<|2>|2>>)\s*/.test(rest)) break;
				const frag = rest.match(/^(\s+)([A-Za-z0-9_\-\\.\(\)\[\]{}%@!^+,=~`]+)/);
				if (!frag) break;
				pathEnd += frag[0].length;
			}
			const fullPath = cmd.slice(i, pathEnd);
			let p = fullPath.replace(/\\([ \t\n\r"'])/g, "$1").replace(/\\/g, "/").replace(/\/$/, "");
			p = fixDrive(p);
			if (p.includes(" ")) result += `'${p}'`;
			else result += p;
			i = pathEnd;
		} else {
			result += cmd[i];
			i++;
		}
	}
	return result;
}

function fixBackslashes(cmd: string): string {
	return cmd.replace(/\\([^\s"'\\])/g, (match, char, offset) => {
		const before = cmd.slice(0, offset);
		if (/\$[A-Za-z_][A-Za-z0-9_]*$/.test(before)) return match;
		const sgl = before.match(/'/g);
		if (sgl && sgl.length % 2 !== 0) return match;
		const dbl = before.match(/"/g);
		if (dbl && dbl.length % 2 !== 0) return match;
		return char;
	});
}

function extractRawPath(expr: string): string {
	let p = expr.trim();
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		p = p.slice(1, -1);
	}
	return p;
}

function toBashPath(expr: string): string {
	let p = expr.trim();
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		p = p.slice(1, -1);
	}
	p = p.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_m, drive) => `/${drive.toLowerCase()}/`).replace(/\/$/, "");
	if (p.includes(" ")) return `'${p}'`;
	return p;
}

function hasUnbalancedQuotes(cmd: string): boolean {
	let dbl = 0;
	let sgl = 0;
	let escaped = false;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (escaped) { escaped = false; continue; }
		if (c === "\\") { escaped = true; continue; }
		if (c === '"') dbl++;
		if (c === "'") sgl++;
	}
	return dbl % 2 !== 0 || sgl % 2 !== 0;
}
