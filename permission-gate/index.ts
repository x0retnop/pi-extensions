// @ts-nocheck

type AskKind =
  | "inline-python-stdin"
  | "inline-python-command"
  | "inline-node-command"
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

// ─── Single source of truth for ask-kinds ───
// Adding a new kind / model variant requires editing ONLY this array.
interface KindMeta {
  kind: AskKind;
  patterns: RegExp[];
  allowSession: boolean; // if false → "Always allow this kind this session" is not offered
}

const KIND_METAS: KindMeta[] = [
  {
    kind: "inline-python-stdin",
    patterns: [
      // PowerShell: @' … '@ | python -
      /^\s*@(['"])[\s\S]*?\1@\s*\|\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-\s*$/i,
      // Bash heredoc: python - <<PY
      /^\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-\s*<<['"]?[A-Z_][A-Z0-9_]*['"]?/is,
    ],
    allowSession: true,
  },
  {
    kind: "inline-python-command",
    patterns: [
      /^\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-c\s+[\s\S]+$/i,
    ],
    allowSession: true,
  },
  {
    kind: "inline-node-command",
    patterns: [
      /^\s*node(?:js)?(?:\s+--experimental-strip-types)?\s+-e\s+[\s\S]+$/i,
    ],
    allowSession: true,
  },
  {
    kind: "build-command",
    patterns: [
      /^\s*npm\s+run\s+build(?:\s+.*)?$/i,
      /^\s*pnpm\s+run\s+build(?:\s+.*)?$/i,
      /^\s*yarn\s+build(?:\s+.*)?$/i,
    ],
    allowSession: true,
  },
  {
    kind: "test-command",
    patterns: [
      /^\s*pytest(?:\s+.*)?$/i,
      /^\s*python\s+-m\s+unittest(?:\s+.*)?$/i,
      /^\s*python\s+.*(?:^|[\\/])?eval_runner\.py(?:\s+.*)?$/i,
      /^\s*python\s+.*[\\/]eval[\\/].*$/i,
      /^\s*npm\s+test(?:\s+.*)?$/i,
      /^\s*npm\s+run\s+test(?:\s+.*)?$/i,
      /^\s*pnpm\s+test(?:\s+.*)?$/i,
      /^\s*pnpm\s+run\s+test(?:\s+.*)?$/i,
      /^\s*yarn\s+test(?:\s+.*)?$/i,
    ],
    allowSession: true,
  },
  {
    kind: "format-command",
    patterns: [
      /(?:^|\s)--fix(?:\s|$)/i,
      /^\s*npm\s+run\s+format(?:\s+.*)?$/i,
      /^\s*pnpm\s+run\s+format(?:\s+.*)?$/i,
      /^\s*yarn\s+format(?:\s+.*)?$/i,
      /^\s*prettier\b.*--write\b/i,
      /^\s*black(?:\s+.*)?$/i,
      /^\s*ruff\s+format(?:\s+.*)?$/i,
    ],
    allowSession: true,
  },
  {
    kind: "install-command",
    patterns: [
      /^\s*npm\s+(?:install|i|update|remove|uninstall|add)(?:\s+.*)?$/i,
      /^\s*pnpm\s+(?:install|update|remove|uninstall|add)(?:\s+.*)?$/i,
      /^\s*yarn\s+(?:install|add|remove|upgrade)(?:\s+.*)?$/i,
      /^\s*pip\s+install(?:\s+.*)?$/i,
      /^\s*python\s+-m\s+pip\s+install(?:\s+.*)?$/i,
    ],
    allowSession: false,
  },
  {
    kind: "delete-command",
    patterns: [
      /^\s*(?:del|erase|rmdir|rd)\b/i,
      /^\s*Remove-Item\b/i,
      /^\s*rm\b/i,
    ],
    allowSession: false,
  },
];

// Derived from KIND_METAS so there is never a mismatch.
const askPatterns = KIND_METAS.flatMap((m) => m.patterns);

const noSessionKinds = new Set<AskKind>(
  KIND_METAS.filter((m) => !m.allowSession).map((m) => m.kind)
);

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
  return /^\s*@(['"])[\s\S]*?\1@\s*\|\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-\s*$/i.test(command);
}

function isBashPythonHeredoc(command: string): boolean {
  return /^\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-\s*<<['"]?[A-Z_][A-Z0-9_]*['"]?/is.test(command);
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
    ".touch(",
    ".mkdir(",
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

  const riskyOpenModes = [
    /\bopen\s*\([^)]*[, ]\s*["'][^"']*[wax+][^"']*["']/i,
    /\.open\s*\([^)]*["'][^"']*[wax+][^"']*["']/i,
  ];

  return (
    !riskyTokens.some((token) => lower.includes(token)) &&
    !riskyOpenModes.some((pattern) => pattern.test(command))
  );
}

function isInlineNode(command: string): boolean {
  return /^\s*node(?:js)?(?:\s+--experimental-strip-types)?\s+-e\s+[\s\S]+$/i.test(command);
}

function looksLikeReadOnlyInlineNode(command: string): boolean {
  if (!isInlineNode(command)) return false;

  const lower = command.toLowerCase();
  const riskyTokens = [
    "fs.write",
    "fs.appendfile",
    "fs.unlink",
    "fs.rmdir",
    "fs.rm",
    "fs.rename",
    "fs.copy",
    "child_process",
    "spawn(",
    "exec(",
    "execsync(",
    "eval(",
    "function(",
    "require('http')",
    "require('https')",
    "require('net')",
    "fetch(",
    "createwritestream",
  ];

  return !riskyTokens.some((token) => lower.includes(token));
}

function isSafeEchoRedirection(command: string): boolean {
  const trimmed = command.trim();
  if (!/^\s*echo\s+/i.test(trimmed)) return false;

  let quote: "'" | '"' | null = null;
  let sawRedirect = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    const next = trimmed[i + 1];

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

    if (ch === ">") {
      sawRedirect = true;
      continue;
    }

    if (ch === "|" || ch === ";" || ch === "&" || ch === "<" || ch === "`" || ch === "\n" || ch === "\r") {
      return false;
    }

    if (ch === "$" && next === "(") return false;
  }

  return sawRedirect;
}

function splitOnSafePipe(command: string): string[] | null {
  const parts: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

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

    if (ch === "|") {
      const part = command.slice(start, i).trim();
      if (!part) return null;
      parts.push(part);
      start = i + 1;
      continue;
    }

    if (ch === "&" || ch === ";" || ch === "<" || ch === ">" || ch === "`" || ch === "\n" || ch === "\r") {
      return null;
    }
  }

  if (quote) return null;

  const last = command.slice(start).trim();
  if (!last) return null;
  parts.push(last);

  return parts.length > 1 ? parts : null;
}

const safePipeTailPatterns: RegExp[] = [
  /^\s*head(?:\s+-n)?\s+\d+\s*$/i,
  /^\s*Select-Object\s+-(?:First|Last)\s+\d+\s*$/i,
  /^\s*more\s*$/i,
];

function isAutoAllowedSafePipeline(command: string): boolean {
  const parts = splitOnSafePipe(command);
  if (!parts || parts.length < 2) return false;

  return parts.every((part) => {
    if (matchesAny(part, blockPatterns)) return false;
    return isAutoAllowedSimpleCommand(part);
  });
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
  /^\s*(?:pwd|cd|chdir)(?:\s+.*)?$/i,
  /^\s*dir(?:\s+.*)?$/i,
  /^\s*Get-ChildItem(?:\s+.*)?$/i,

  // Common Unix-style read-only / safe commands.
  /^\s*ls(?:\s+.*)?$/i,
  /^\s*ll(?:\s+.*)?$/i,
  /^\s*la(?:\s+.*)?$/i,
  /^\s*grep(?:\s+.*)?$/i,
  /^\s*echo(?:\s+.*)?$/i,
  /^\s*mkdir(?:\s+.*)?$/i,
  /^\s*cat(?:\s+.*)?$/i,

  // Node.js read-only / safe-only invocations.
  /^\s*node(?:js)?(?:\s+(?:--version|-v|--help))(?:\s+.*)?$/i,
  /^\s*node(?:js)?(?:\s+(?:-p|--print))(?:\s+.*)?$/i,
  /^\s*node(?:js)?(?:\s+(?:-c|--check))(?:\s+.*)?$/i,

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
    if (looksLikeReadOnlyInlineNode(trimmed)) {
      return true;
    }
  }

  if (isSafeEchoRedirection(trimmed)) {
    return true;
  }

  if (hasShellControlOperators(trimmed)) {
    return false;
  }

  // Ask-kinds must go through the explicit ask flow, not auto-allow.
  if (matchesAny(trimmed, askPatterns)) {
    return false;
  }

  return matchesAny(trimmed, allowPatterns);
}

function isAutoAllowedCompoundCommand(command: string): boolean {
  const parts = splitOnShellAndAnd(command);
  if (!parts || parts.length < 2) return false;

  return parts.every((part) => {
    // Guard: any block or ask inside a compound must trigger explicit review.
    if (matchesAny(part, blockPatterns) || matchesAny(part, askPatterns)) {
      return false;
    }
    return isAutoAllowedSimpleCommand(part) || isAutoAllowedSafePipeline(part);
  });
}

function getAskKind(command: string): AskKind | undefined {
  for (const meta of KIND_METAS) {
    if (matchesAny(command, meta.patterns)) return meta.kind;
  }
  return undefined;
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

    // 1. Hard blocks (immediate, no session override)
    if (matchesAny(command, blockPatterns)) {
      return {
        block: true,
        reason: `Blocked by permission-gate:\n${command}`,
      };
    }

    // 2. Exact command already approved this session
    if (sessionAllowedCommands.has(normalizeCommand(command))) {
      return undefined;
    }

    // 3. Auto-allow heuristics
    if (
      isSafeTempPyDelete(command) ||
      isAutoAllowedSafePipeline(command) ||
      isAutoAllowedCompoundCommand(command) ||
      isAutoAllowedSimpleCommand(command)
    ) {
      return undefined;
    }

    // 4. Known ask-kinds (single source of truth: KIND_METAS)
    const kind = getAskKind(command);
    if (kind) {
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

    // 5. Compound / control operators that did not match above
    if (hasShellControlOperators(command)) {
      const compoundKind: AskKind = "compound-command";
      const decision = await askAllowOnceOrSession(
        ctx,
        `Compound shell command detected. Allow once?\n\n${command}`,
        compoundKind
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

    // 6. Truly unknown command
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
