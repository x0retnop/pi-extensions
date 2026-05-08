// @ts-nocheck

type AskKind =
  | "inline-python-stdin"
  | "inline-python-command"
  | "build-command"
  | "test-command"
  | "format-command"
  | "install-command"
  | "delete-command"
  | "compound-command"
  | "known-ask-command"
  | "unknown-command";

type GateMode = "strict" | "balanced" | "relaxed";

const CONFIG = {
  mode: "relaxed" as GateMode,
};

const sessionAllowedKinds = new Set<AskKind>();
const sessionAllowedCommands = new Set<string>();

const noSessionKinds = new Set<AskKind>([
  "install-command",
  "delete-command",
  "compound-command",
  "unknown-command",
]);

function getCommand(input: any): string {
  return String(input?.command ?? "").trim();
}

function matchesAny(command: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(command));
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

const safeTempPyPath = String.raw`(?:(?:"(?:\.[\\/])?_temp\.py")|(?:'(?:\.[\\/])?_temp\.py')|(?:(?:\.[\\/])?_temp\.py))`;
const safeTempPyDeletePatterns: RegExp[] = [
  new RegExp(String.raw`^\s*(?:del|erase)(?:\s+/[a-z]+)*\s+${safeTempPyPath}\s*$`, "i"),
  new RegExp(String.raw`^\s*rm(?:\s+-f)?\s+${safeTempPyPath}\s*$`, "i"),
  new RegExp(String.raw`^\s*Remove-Item(?:\s+-(?:Force|LiteralPath|Path))*\s+${safeTempPyPath}(?:\s+-(?:Force))*\s*$`, "i"),
];

function isSafeTempPyDelete(command: string): boolean {
  return matchesAny(command, safeTempPyDeletePatterns);
}

function splitOnShellAndAnd(command: string): string[] | null {
  const parts: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "&" && next === "&") {
      const part = command.slice(start, i).trim();
      if (!part) return null;
      parts.push(part);
      i += 1;
      start = i + 1;
      continue;
    }

    if (ch === "&" || ch === "|" || ch === ";" || ch === "<" || ch === ">" || ch === "`" || ch === "\n" || ch === "\r") {
      return null;
    }
  }

  if (quote) return null;

  const last = command.slice(start).trim();
  if (!last) return null;
  parts.push(last);

  return parts.length > 1 ? parts : null;
}

function isPowerShellPythonStdin(command: string): boolean {
  // Matches:
  // @'
  // print("hello")
  // '@ | python -
  return /^\s*@(['"])[\s\S]*?\1@\s*\|\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-\s*$/i.test(
    command
  );
}

function isBashPythonHeredoc(command: string): boolean {
  return /^\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-\s*<<['"]?[A-Z_][A-Z0-9_]*['"]?/is.test(
    command
  );
}

function isInlinePython(command: string): boolean {
  return (
    isPowerShellPythonStdin(command) ||
    isBashPythonHeredoc(command) ||
    /^\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-c\s+[\s\S]+$/i.test(command)
  );
}

function looksLikeReadOnlyInlinePython(command: string): boolean {
  if (!isInlinePython(command)) return false;

  const lower = command.toLowerCase();
  const riskyTokens = [
    "write_text",
    "write_bytes",
    ".write(",
    "open(",
    "'w'",
    '"w"',
    "'a'",
    '"a"',
    "unlink(",
    "remove(",
    "rmdir(",
    "removedirs(",
    "shutil.rmtree",
    "shutil.move",
    "shutil.copy",
    "rename(",
    "replace(",
    "subprocess",
    "system(",
    "popen(",
    "pip install",
    "urllib.request",
    "requests.",
    "httpx.",
    "socket.",
  ];

  return !riskyTokens.some((token) => lower.includes(token));
}

function hasShellControlOperators(command: string): boolean {
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "`") return true;
      if (ch === "$" && next === "(") return true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "\n" || ch === "\r") return true;
    if (ch === ";" || ch === "<" || ch === ">" || ch === "`") return true;
    if (ch === "&" || ch === "|") return true;
    if (ch === "$" && next === "(") return true;
  }

  return false;
}

const allowPatterns: RegExp[] = [
  // Basic Windows-friendly read-only shell commands.
  /^\s*(?:pwd|cd|chdir)\s*$/i,
  /^\s*dir(?:\s+.*)?$/i,
  /^\s*Get-ChildItem(?:\s+.*)?$/i,

  // ripgrep: default search and file discovery tool.
  /^\s*rg(?:\s+.*)?$/i,

  // Git read-only commands.
  /^\s*git\s+status(?:\s+.*)?$/i,
  /^\s*git\s+diff(?:\s+.*)?$/i,
  /^\s*git\s+-C\s+\S+\s+(?:status|diff|log|show|branch|tag|ls-remote|fetch|blame|grep|describe|stash\s+(?:list|show))\b(?:\s+.*)?$/i,
  /^\s*git\s+log(?:\s+.*)?$/i,
  /^\s*git\s+branch(?:\s+.*)?$/i,
  /^\s*git\s+show(?:\s+.*)?$/i,
  /^\s*git\s+rev-parse(?:\s+.*)?$/i,
  /^\s*git\s+remote(?:\s+.*)?$/i,
  /^\s*git\s+ls-files(?:\s+.*)?$/i,

  // Python syntax checks. These may create __pycache__, but do not change source files.
  /^\s*python\s+-m\s+py_compile(?:\s+.*)?$/i,
  /^\s*python\s+-m\s+compileall(?:\s+.*)?$/i,

  // TypeScript / Node.js error checks that should not emit files.
  /^\s*npx\s+--no-install\s+tsc\s+--noEmit(?:\s+.*)?$/i,
  /^\s*npx\s+tsc\s+--noEmit(?:\s+.*)?$/i,
  /^\s*tsc\s+--noEmit(?:\s+.*)?$/i,

  // Existing package scripts commonly used as checks. Fix/build/test variants are handled below before allow.
  /^\s*npm\s+run\s+typecheck(?:\s+.*)?$/i,
  /^\s*npm\s+run\s+check(?:\s+.*)?$/i,
  /^\s*npm\s+run\s+lint(?:\s+.*)?$/i,

  /^\s*pnpm\s+run\s+typecheck(?:\s+.*)?$/i,
  /^\s*pnpm\s+run\s+check(?:\s+.*)?$/i,
  /^\s*pnpm\s+run\s+lint(?:\s+.*)?$/i,

  /^\s*yarn\s+typecheck(?:\s+.*)?$/i,
  /^\s*yarn\s+check(?:\s+.*)?$/i,
  /^\s*yarn\s+lint(?:\s+.*)?$/i,
];

const relaxedAllowPatterns: RegExp[] = [
  // Package/library metadata lookups. These inspect registries or local metadata, but do not install.
  /^\s*npm\s+(?:view|info|search|repo|docs|bugs|home|ls)\b(?:\s+.*)?$/i,
  /^\s*pnpm\s+(?:view|info|search|why|list|ls)\b(?:\s+.*)?$/i,
  /^\s*yarn\s+(?:info|why|list)\b(?:\s+.*)?$/i,
  /^\s*(?:pip|pip3)\s+(?:show|index\s+versions|list|freeze)\b(?:\s+.*)?$/i,
  /^\s*python\s+-m\s+pip\s+(?:show|index\s+versions|list|freeze)\b(?:\s+.*)?$/i,
  /^\s*uv\s+pip\s+(?:show|list|freeze)\b(?:\s+.*)?$/i,
  /^\s*cargo\s+(?:search|info|metadata|tree)\b(?:\s+.*)?$/i,
  /^\s*go\s+list\b(?:\s+.*)?$/i,
  /^\s*dotnet\s+(?:package\s+search|nuget\s+list)\b(?:\s+.*)?$/i,
  /^\s*composer\s+(?:show|search|info)\b(?:\s+.*)?$/i,
  /^\s*gem\s+(?:info|query|search|list)\b(?:\s+.*)?$/i,
];

const askPatterns: RegExp[] = [
  // Multi-line or arbitrary Python. Useful for project-local reads/edits, but not safe to auto-allow globally.
  /^\s*@(['"])[\s\S]*?\1@\s*\|\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-\s*$/i,
  /^\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-\s*<<['"]?[A-Z_][A-Z0-9_]*['"]?/is,
  /^\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-c\s+[\s\S]+$/i,

  // Builds may write files, run generators, postbuild scripts, etc.
  /^\s*npm\s+run\s+build(?:\s+.*)?$/i,
  /^\s*pnpm\s+run\s+build(?:\s+.*)?$/i,
  /^\s*yarn\s+build(?:\s+.*)?$/i,

  // Real tests can be slow or have project-specific side effects.
  /^\s*pytest(?:\s+.*)?$/i,
  /^\s*python\s+-m\s+unittest(?:\s+.*)?$/i,
  /^\s*python\s+.*(?:^|[\\/])?eval_runner\.py(?:\s+.*)?$/i,
  /^\s*python\s+.*[\\/]eval[\\/].*$/i,
  /^\s*npm\s+test(?:\s+.*)?$/i,
  /^\s*npm\s+run\s+test(?:\s+.*)?$/i,
  /^\s*pnpm\s+test(?:\s+.*)?$/i,
  /^\s*pnpm\s+run\s+test(?:\s+.*)?$/i,
  /^\s*yarn\s+test(?:\s+.*)?$/i,

  // Formatters or fixers that usually rewrite files.
  /(?:^|\s)--fix(?:\s|$)/i,
  /^\s*npm\s+run\s+format(?:\s+.*)?$/i,
  /^\s*pnpm\s+run\s+format(?:\s+.*)?$/i,
  /^\s*yarn\s+format(?:\s+.*)?$/i,
  /^\s*prettier\b.*\b--write\b/i,
  /^\s*black(?:\s+.*)?$/i,
  /^\s*ruff\s+format(?:\s+.*)?$/i,

  // Package changes / installs / updates.
  /^\s*npm\s+(?:install|i|update|remove|uninstall|add)(?:\s+.*)?$/i,
  /^\s*pnpm\s+(?:install|update|remove|uninstall|add)(?:\s+.*)?$/i,
  /^\s*yarn\s+(?:install|add|remove|upgrade)(?:\s+.*)?$/i,
  /^\s*pip\s+install(?:\s+.*)?$/i,
  /^\s*python\s+-m\s+pip\s+install(?:\s+.*)?$/i,

  // Destructive file operations should require explicit approval.
  /^\s*(?:del|erase|rmdir|rd)\b/i,
  /^\s*Remove-Item\b/i,
  /^\s*rm\b/i,
];

const blockPatterns: RegExp[] = [
  // Clearly dangerous system-level commands.
  /^\s*format\b/i,
  /^\s*diskpart\b/i,
  /^\s*bcdedit\b/i,
  /^\s*shutdown\b/i,
  /^\s*restart-computer\b/i,
  /^\s*stop-computer\b/i,
  /^\s*Set-ExecutionPolicy\b/i,

  // High-risk Git operations.
  /^\s*git\s+clean\b/i,
  /^\s*git\s+reset\s+--hard\b/i,
  /^\s*git\s+(?:-C\s+\S+\s+)?checkout\s+--\s+/i,
  /^\s*git\s+(?:-C\s+\S+\s+)?restore\b/i,

  // Obvious root / drive deletion patterns.
  /^\s*rm\s+-rf\s+[\/\\]\s*$/i,
  /^\s*rm\s+-rf\s+["']?[A-Z]:[\\\/]?["']?\s*$/i,
  /^\s*del\s+\/[fsq]+\s+[A-Z]:[\\\/]?/i,
  /^\s*rmdir\s+\/s\s+\/q\s+[A-Z]:[\\\/]?/i,
  /^\s*Remove-Item\b.*\b[A-Z]:[\\\/]?\b.*\b-Recurse\b.*\b-Force\b/i,

  // Obfuscated or policy-bypassing execution.
  /\bInvoke-Expression\b/i,
  /\biex\b/i,
  /\bExecutionPolicy\s+Bypass\b/i,
  /\bFromBase64String\b/i,
  /\bsudo\b/i,
  /\bchmod\b.*777\b/i,
  /\bchown\b/i,
];


function isAutoAllowedSimpleCommand(command: string): boolean {
  const trimmed = command.trim();

  if (!trimmed || matchesAny(trimmed, blockPatterns)) {
    return false;
  }

  if (isSafeTempPyDelete(trimmed)) {
    return true;
  }

  if (CONFIG.mode === "relaxed") {
    if (matchesAny(trimmed, relaxedAllowPatterns)) {
      return true;
    }

    if (looksLikeReadOnlyInlinePython(trimmed)) {
      return true;
    }
  }

  if (hasShellControlOperators(trimmed)) {
    return false;
  }

  if (matchesAny(trimmed, askPatterns)) {
    return false;
  }

  return matchesAny(trimmed, allowPatterns);
}

function isAutoAllowedCompoundCommand(command: string): boolean {
  const parts = splitOnShellAndAnd(command);
  return parts !== null && parts.every(isAutoAllowedSimpleCommand);
}

function getAskKind(command: string): AskKind {
  if (isPowerShellPythonStdin(command) || isBashPythonHeredoc(command)) {
    return "inline-python-stdin";
  }

  if (/^\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-c\s+[\s\S]+$/i.test(command)) {
    return "inline-python-command";
  }

  if (
    /^\s*npm\s+run\s+build(?:\s+.*)?$/i.test(command) ||
    /^\s*pnpm\s+run\s+build(?:\s+.*)?$/i.test(command) ||
    /^\s*yarn\s+build(?:\s+.*)?$/i.test(command)
  ) {
    return "build-command";
  }

  if (
    /^\s*pytest(?:\s+.*)?$/i.test(command) ||
    /^\s*python\s+-m\s+unittest(?:\s+.*)?$/i.test(command) ||
    /^\s*python\s+.*(?:^|[\\/])?eval_runner\.py(?:\s+.*)?$/i.test(command) ||
    /^\s*python\s+.*[\\/]eval[\\/].*$/i.test(command) ||
    /^\s*npm\s+test(?:\s+.*)?$/i.test(command) ||
    /^\s*npm\s+run\s+test(?:\s+.*)?$/i.test(command) ||
    /^\s*pnpm\s+test(?:\s+.*)?$/i.test(command) ||
    /^\s*pnpm\s+run\s+test(?:\s+.*)?$/i.test(command) ||
    /^\s*yarn\s+test(?:\s+.*)?$/i.test(command)
  ) {
    return "test-command";
  }

  if (
    /(?:^|\s)--fix(?:\s|$)/i.test(command) ||
    /^\s*npm\s+run\s+format(?:\s+.*)?$/i.test(command) ||
    /^\s*pnpm\s+run\s+format(?:\s+.*)?$/i.test(command) ||
    /^\s*yarn\s+format(?:\s+.*)?$/i.test(command) ||
    /^\s*prettier\b.*\b--write\b/i.test(command) ||
    /^\s*black(?:\s+.*)?$/i.test(command) ||
    /^\s*ruff\s+format(?:\s+.*)?$/i.test(command)
  ) {
    return "format-command";
  }

  if (
    /^\s*npm\s+(?:install|i|update|remove|uninstall|add)(?:\s+.*)?$/i.test(command) ||
    /^\s*pnpm\s+(?:install|update|remove|uninstall|add)(?:\s+.*)?$/i.test(command) ||
    /^\s*yarn\s+(?:install|add|remove|upgrade)(?:\s+.*)?$/i.test(command) ||
    /^\s*pip\s+install(?:\s+.*)?$/i.test(command) ||
    /^\s*python\s+-m\s+pip\s+install(?:\s+.*)?$/i.test(command)
  ) {
    return "install-command";
  }

  if (
    /^\s*(?:del|erase|rmdir|rd)\b/i.test(command) ||
    /^\s*Remove-Item\b/i.test(command) ||
    /^\s*rm\b/i.test(command)
  ) {
    return "delete-command";
  }

  return "known-ask-command";
}

async function askAllowOnceOrSession(
  ctx: any,
  message: string,
  kind: AskKind
): Promise<"once" | "command" | "session" | "block"> {
  if (!ctx?.hasUI) return "block";

  const choices = noSessionKinds.has(kind)
    ? ["Allow once", "Always allow exact command this session", "Block"]
    : ["Allow once", "Always allow exact command this session", "Always allow this kind this session", "Block"];

  const choice = await ctx.ui.select(message, choices);

  if (choice === "Allow once") return "once";
  if (choice === "Always allow exact command this session") return "command";
  if (choice === "Always allow this kind this session") return "session";
  return "block";
}

export default function (pi: any) {
  pi.on("session_start", async () => {
    sessionAllowedKinds.clear();
    sessionAllowedCommands.clear();
  });

  pi.on("session_shutdown", async () => {
    sessionAllowedKinds.clear();
    sessionAllowedCommands.clear();
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const tool = String(event.toolName ?? "");

    if (tool !== "bash") {
      return undefined;
    }

    const command = getCommand(event.input);

    if (!command) {
      return undefined;
    }

    if (matchesAny(command, blockPatterns)) {
      return {
        block: true,
        reason: `Blocked by permission-gate.ts:\n${command}`,
      };
    }

    if (sessionAllowedCommands.has(normalizeCommand(command))) {
      return undefined;
    }

    if (isSafeTempPyDelete(command) || isAutoAllowedSimpleCommand(command) || isAutoAllowedCompoundCommand(command)) {
      return undefined;
    }

    if (matchesAny(command, askPatterns)) {
      const kind = getAskKind(command);

      if (sessionAllowedKinds.has(kind)) {
        return undefined;
      }

      const decision = await askAllowOnceOrSession(
        ctx,
        `Allow command?\n\nKind: ${kind}\n\n${command}`,
        kind
      );

      if (decision === "session") {
        sessionAllowedKinds.add(kind);
        return undefined;
      }

      if (decision === "command") {
        sessionAllowedCommands.add(normalizeCommand(command));
        return undefined;
      }

      if (decision === "once") {
        return undefined;
      }

      return {
        block: true,
        reason: `User denied command:\n${command}`,
      };
    }

    if (hasShellControlOperators(command)) {
      const kind: AskKind = "compound-command";

      const decision = await askAllowOnceOrSession(
        ctx,
        `Compound shell command detected. Allow once?\n\n${command}`,
        kind
      );

      if (decision === "command") {
        sessionAllowedCommands.add(normalizeCommand(command));
        return undefined;
      }

      if (decision === "once") {
        return undefined;
      }

      return {
        block: true,
        reason: `Blocked compound shell command:\n${command}`,
      };
    }

    if (matchesAny(command, allowPatterns)) {
      return undefined;
    }

    const decision = await askAllowOnceOrSession(
      ctx,
      `Unknown command. Allow once?\n\n${command}`,
      "unknown-command"
    );

    if (decision === "command") {
      sessionAllowedCommands.add(normalizeCommand(command));
      return undefined;
    }

    if (decision === "once") {
      return undefined;
    }

    return {
      block: true,
      reason: `Blocked unknown command:\n${command}`,
    };
  });
}