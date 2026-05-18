import { tokenize } from "./tokenizer.js";
import { analyzeCommand } from "./analyzer.js";
import type { Decision, GateMode, AnalyzedCommand } from "./types.js";
import {
  classifyPathAccess,
  commandHasTraversal,
  commandMentionsExternalOrProtectedPath,
} from "./path-guard.js";

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

const SAFE_TEMP_PATTERNS = [
  /^\s*(?:del|erase)(?:\s+\/[a-z]+)*\s+["']?(?:\.[\\/])?_temp\.py["']?\s*$/i,
  /^\s*rm(?:\s+-f)?\s+["']?(?:\.[\\/])?_temp\.py["']?\s*$/i,
  /^\s*Remove-Item(?:\s+-(?:Force|LiteralPath|Path))*\s+["']?(?:\.[\\/])?_temp\.py["']?(?:\s+-(?:Force))*\s*$/i,
];

export function isSafeTempDelete(command: string): boolean {
  return SAFE_TEMP_PATTERNS.some((p) => p.test(command));
}

function fallbackNeedsAsk(risk: string, mode: GateMode): boolean {
  switch (mode) {
    case "strict":
      return risk !== "read";
    case "balanced":
      return risk === "execute" || risk === "delete" || risk === "install" || risk === "destructive" || risk === "unknown";
    case "relaxed":
      return risk === "execute" || risk === "delete" || risk === "install" || risk === "destructive" || risk === "unknown";
    case "yolo":
      return risk === "delete" || risk === "install" || risk === "destructive";
    default:
      return true;
  }
}

export function analyze(command: string): AnalyzedCommand {
  const parts = tokenize(command);
  return analyzeCommand(parts);
}

function isExternalWriteLike(command: string): boolean {
  if (/^\s*(?:cp|copy|xcopy|robocopy|mv|move|New-Item|Set-Content|Add-Content|Out-File|cmd\s+\/c|powershell|pwsh)\b/i.test(command)) {
    return true;
  }
  // Strip safe null redirects before checking for real output redirections
  const cleaned = command
    .replace(/\s*2>\s*["']?\/dev\/null["']?/g, "")
    .replace(/\s*1?>\s*["']?\/dev\/null["']?/g, "")
    .replace(/\s*2>\s*["']?nul["']?/gi, "")
    .replace(/\s*1?>\s*["']?nul["']?/gi, "");
  return />{1,2}/.test(cleaned);
}

function stripLeadingCd(command: string): { body: string; cdTarget: string | null } {
  const m = command.match(/^\s*cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*(?:&&|\|\||;)\s*/);
  if (!m) return { body: command, cdTarget: null };
  const target = m[1] ?? m[2] ?? m[3] ?? null;
  return { body: command.slice(m[0].length), cdTarget: target };
}

function checkBashPathRisk(command: string, cwd: string): Decision | null {
  const { body, cdTarget } = stripLeadingCd(command);

  if (commandHasTraversal(body) && isExternalWriteLike(body)) {
    return {
      action: "block",
      reason: `Blocked bash command with path traversal:\n${command}`,
    };
  }

  if (commandMentionsExternalOrProtectedPath(body) && isExternalWriteLike(body)) {
    return {
      action: "ask",
      reason: `Bash command may write outside current project.\n\n${command}`,
    };
  }

  // If cd changes to external/protected dir and subsequent command is write-like
  if (cdTarget && isExternalWriteLike(body)) {
    const access = classifyPathAccess(cdTarget, cwd);
    if (access.scope === "protected") {
      return {
        action: "block",
        reason: `Blocked bash command changing to protected directory:\n${command}`,
      };
    }
    if (access.scope === "outside_project") {
      return {
        action: "ask",
        reason: `Bash command writes after cd to outside project.\n\n${command}`,
      };
    }
  }

  return null;
}

export function decide(
  command: string,
  mode: GateMode,
  sessionAllowedCommands: Set<string>
): Decision {
  const normalized = normalizeCommand(command);

  if (sessionAllowedCommands.has(normalized)) {
    return { action: "allow" };
  }

  const { body: bodyForSafeCheck } = stripLeadingCd(command);
  if (isSafeTempDelete(bodyForSafeCheck) || isSafeTempDelete(command)) {
    return { action: "allow" };
  }

  const analysis = analyze(command);

  if (analysis.risk === "destructive") {
    return {
      action: "block",
      reason: `Blocked destructive command (${analysis.categories.join(", ")})`,
    };
  }

  if (mode === "yolo" && (analysis.risk === "install" || analysis.risk === "delete")) {
    return {
      action: "ask",
      reason: `${analysis.risk} command requires confirmation in yolo mode`,
    };
  }

  let allAllowed = true;
  for (const part of analysis.parts) {
    for (const seg of part.segments) {
      const segAllowed = seg.autoAllowModes.includes(mode) || !fallbackNeedsAsk(seg.risk, mode);
      if (!segAllowed) {
        allAllowed = false;
      }
    }
  }
  if (allAllowed) {
    return { action: "allow" };
  }

  if (!fallbackNeedsAsk(analysis.risk, mode)) {
    return { action: "allow" };
  }

  return {
    action: "ask",
    reason: `${analysis.risk} command requires confirmation in ${mode} mode`,
  };
}

function isSafeReadBash(analysis: AnalyzedCommand): boolean {
  if (analysis.isCompound) return false;
  const badCats = new Set(["delete", "execute", "install", "destructive", "unknown"]);
  for (const cat of analysis.categories) {
    if (badCats.has(cat)) return false;
  }
  if (analysis.risk !== "read" && analysis.risk !== "network") return false;
  return true;
}

export function decideBash(
  command: string,
  mode: GateMode,
  sessionAllowedCommands: Set<string>,
  cwd: string
): Decision {
  // Path risk check first
  const pathDecision = checkBashPathRisk(command, cwd);
  if (pathDecision) {
    // In yolo mode, allow safe read-only commands outside the project
    if (mode === "yolo" && pathDecision.action === "ask") {
      const analysis = analyze(command);
      if (isSafeReadBash(analysis)) {
        return { action: "allow" };
      }
    }
    return pathDecision;
  }

  const decision = decide(command, mode, sessionAllowedCommands);

  // YOLO: safe read outside project is allowed; anything else outside project requires confirmation
  if (mode === "yolo" && decision.action === "allow") {
    const { body } = stripLeadingCd(command);
    if (commandMentionsExternalOrProtectedPath(body)) {
      const analysis = analyze(command);
      if (isSafeReadBash(analysis)) {
        return { action: "allow" };
      }
      return {
        action: "ask",
        reason: `Command outside current project requires confirmation in yolo mode`,
      };
    }
  }

  return decision;
}

export function riskEmoji(risk: string): string {
  switch (risk.toLowerCase()) {
    case "read": return "🟢";
    case "write": return "🟡";
    case "network": return "🔵";
    case "execute": return "🟠";
    case "install": return "🟠";
    case "delete": return "🔴";
    case "destructive": return "⛔";
    default: return "⚠️";
  }
}

function extractRiskFromReason(reason?: string): string {
  if (!reason) return "unknown";
  const m = reason.match(/\b(read|write|delete|execute|install|destructive|network)\b/i);
  if (m) return m[1].toLowerCase();
  if (/block/i.test(reason)) return "destructive";
  if (/copy|move|cp|mv/i.test(reason)) return "write";
  if (/remove|rm|del/i.test(reason)) return "delete";
  if (/run|shell/i.test(reason)) return "execute";
  return "unknown";
}

export function formatBashPrompt(command: string, decision: Decision): string {
  const risk = extractRiskFromReason(decision.reason);
  const emoji = riskEmoji(risk);
  const riskLabel = risk.toUpperCase();
  const reason = decision.reason || "Elevated risk";
  return `${emoji} ${riskLabel} — command requires confirmation\n\nCommand:\n  ${command}\n\nReason:\n  ${reason}`;
}

export function formatReadPrompt(filePath: string, reason: string): string {
  return `🟢 READ — outside current project\n\nFile:\n  ${filePath}\n\nScope:\n  ${reason}`;
}

export function formatWritePrompt(tool: string, filePath: string, reason: string): string {
  return `🟡 WRITE — ${tool.toUpperCase()} outside project\n\nFile:\n  ${filePath}\n\nScope:\n  ${reason}\n\n⚠️ This will modify files outside the active project.`;
}

export function formatWriteConfirm(tool: string, filePath: string): string {
  return `🔴 Final confirmation — ${tool.toUpperCase()}\n\nFile:\n  ${filePath}\n\nThis change is outside the project. Are you absolutely sure?`;
}

export async function askAllowOnceOrSession(
  ctx: any,
  message: string
): Promise<"once" | "command" | "block"> {
  if (!ctx?.hasUI) return "block";

  const choices = ["Allow once", "Always allow this command", "Block"];
  const choice = await ctx.ui.select(message, choices);

  if (choice === "Allow once") return "once";
  if (choice === "Always allow this command") return "command";
  return "block";
}

export async function askReadAccess(
  ctx: any,
  message: string
): Promise<"once" | "directory" | "block"> {
  if (!ctx?.hasUI) return "block";

  const choice = await ctx.ui.select(message, [
    "Allow once",
    "Allow this directory",
    "Block",
  ]);

  if (choice === "Allow once") return "once";
  if (choice === "Allow this directory") return "directory";
  return "block";
}

export async function askTwice(
  ctx: any,
  firstMessage: string,
  secondMessage: string
): Promise<boolean> {
  if (!ctx?.hasUI) return false;

  const first = await ctx.ui.select(
    firstMessage,
    ["Yes, allow", "No, block"]
  );
  if (first !== "Yes, allow") return false;

  const second = await ctx.ui.select(
    secondMessage,
    ["Yes, I am sure", "No"]
  );
  return second === "Yes, I am sure";
}
