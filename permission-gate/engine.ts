import { tokenize } from "./tokenizer.js";
import { analyzeCommand } from "./analyzer.js";
import type { Decision, GateMode, AnalyzedCommand } from "./types.js";
import type { PathScope } from "./path-guard.js";
import {
  classifyPathAccess,
  commandHasTraversal,
  loadWorkspaceRoots,
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

function checkSafeServerCommands(command: string, mode: GateMode): Decision | null {
  if (mode !== "relaxed" && mode !== "yolo") return null;

  const normalized = normalizeCommand(command);

  // Stop local uvicorn server
  if (/^\s*(pkill|killall)(?:\s+-[a-zA-Z0-9]+)*\s+uvicorn\s*$/i.test(normalized)) {
    return { action: "allow", reason: "safe server stop (uvicorn)" };
  }

  // Check port status (netstat/ss piped to grep/findstr)
  if (/^\s*(netstat|ss)\s+\S+.*\|\s*(grep|findstr)\s+\S+/i.test(normalized)) {
    return { action: "allow", reason: "safe port check" };
  }

  // Start uvicorn server — single command only, no pipes/compounds
  const analysis = analyze(command);
  if (!analysis.isCompound && !analysis.isPipeline) {
    if (/^\s*(?:(?:python3?|py)(?:\s+-[a-zA-Z0-9]+)*\s+)?uvicorn\b/i.test(normalized)) {
      return { action: "allow", reason: "safe server start (uvicorn)" };
    }
  }

  return null;
}

function isAiHelper(command: string): Decision | null {
  const normalized = normalizeCommand(command);
  // Allow python / python3 / py (with optional flags) running ai_helper.py
  if (/^\s*(?:python3?|py)(?:\s+-[a-zA-Z0-9]+)*\s+.*?ai-helper[\\/]ai_helper\.py\b/i.test(normalized)) {
    return { action: "allow", reason: "ai_helper.py gate script" };
  }
  return null;
}

function isKimiWebbridge(command: string): Decision | null {
  const normalized = normalizeCommand(command);
  // Allow curl calls to the local kimi-webbridge daemon
  if (/^\s*curl\s+.*http:\/\/127\.0\.0\.1:10086\/command/i.test(normalized)) {
    return { action: "allow", reason: "kimi-webbridge local daemon" };
  }
  // Allow kimi-webbridge binary invocations
  if (/~\/.kimi-webbridge\/bin\/kimi-webbridge\b/i.test(normalized)) {
    return { action: "allow", reason: "kimi-webbridge daemon binary" };
  }
  // Allow the screenshot helper script
  if (/kimi-webbridge[\\/]scripts[\\/]screenshot\.sh\b/i.test(normalized)) {
    return { action: "allow", reason: "kimi-webbridge screenshot helper" };
  }
  return null;
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
  const workspaceRoots = loadWorkspaceRoots();

  // Block traversal + write-like only when resolved path leaves project/workspace
  if (isExternalWriteLike(body) && commandHasTraversal(body)) {
    const targets = extractBashPathTargets(body, cwd, workspaceRoots);
    const hasOutside = targets.some((t) => {
      if (!t.path.includes("..")) return false;
      const resolved = classifyPathAccess(t.path, cwd, workspaceRoots);
      return resolved.scope === "outside_project" || resolved.scope === "protected";
    });
    if (hasOutside) {
      return {
        action: "block",
        reason:
          `Blocked bash command with path traversal outside project/workspace:\n${command}\n\n` +
          `This is restricted by the user's permission gate settings. ` +
          `Do not attempt to bypass this block using python, node, PowerShell, or other interpreters.`,
      };
    }
  }

  // Check actual extracted paths for external/protected write targets
  if (isExternalWriteLike(body)) {
    const targets = extractBashPathTargets(body, cwd, workspaceRoots);
    const hasOutside = targets.some((t) => t.scope === "outside_project" || t.scope === "protected");
    if (hasOutside) {
      return {
        action: "ask",
        reason: `Bash command may write outside current project/workspace.\n\n${command}`,
      };
    }
  }

  // If cd changes to external/protected dir and subsequent command is write-like
  if (cdTarget && isExternalWriteLike(body)) {
    const access = classifyPathAccess(cdTarget, cwd, workspaceRoots);
    if (access.scope === "protected") {
      return {
        action: "block",
        reason:
          `Blocked bash command changing to protected directory:\n${command}\n\n` +
          `This is restricted by the user's permission gate settings. ` +
          `Do not attempt to bypass this block using python, node, PowerShell, or other interpreters.`,
      };
    }
    if (access.scope === "outside_project") {
      return {
        action: "ask",
        reason: `Bash command writes after cd to outside project/workspace.\n\n${command}`,
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
      reason:
        `Blocked destructive command (${analysis.categories.join(", ")}). ` +
        `This operation is restricted by the user's permission gate settings. ` +
        `Do not attempt to bypass this restriction using python, node, PowerShell, or other interpreters. ` +
        `If this operation is genuinely required, explain why to the user and wait for explicit approval.`,
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

function extractBashPathTargets(
  command: string,
  cwd: string,
  workspaceRoots?: string[]
): Array<{ path: string; scope: PathScope }> {
  const analysis = analyze(command);
  const targets: Array<{ path: string; scope: PathScope }> = [];
  const INTERPRETERS_WITH_INLINE = new Set([
    "python", "python3", "py", "node", "nodejs", "ruby", "perl", "php", "java",
  ]);

  for (const part of analysis.parts) {
    for (const seg of part.segments) {
      const cmd = seg.commandName.toLowerCase();
      const hasInlineFlag = seg.flags.some((f) => f === "-c" || f === "-e");
      const isInterpreter = INTERPRETERS_WITH_INLINE.has(cmd);

      let sawDoubleDash = false;
      for (let i = 1; i < seg.argv.length; i++) {
        const tok = seg.argv[i];
        if (!sawDoubleDash) {
          if (tok === "--") {
            sawDoubleDash = true;
            continue;
          }
          if (tok.startsWith("-")) continue;
        }
        // Skip inline code argument for interpreters
        if (isInterpreter && hasInlineFlag && i === seg.argv.length - 1) continue;

        let path = tok;
        if (
          (path.startsWith('"') && path.endsWith('"')) ||
          (path.startsWith("'") && path.endsWith("'"))
        ) {
          path = path.slice(1, -1);
        }
        if (!path) continue;
        const access = classifyPathAccess(path, cwd, workspaceRoots);
        targets.push({ path, scope: access.scope });
      }

      for (const red of seg.redirects) {
        if (red.target) {
          const access = classifyPathAccess(red.target, cwd, workspaceRoots);
          targets.push({ path: red.target, scope: access.scope });
        }
      }
    }
  }
  return targets;
}

export function decideBash(
  command: string,
  mode: GateMode,
  sessionAllowedCommands: Set<string>,
  cwd: string
): Decision {
  // Trusted helper script — bypass path/write checks
  const helperDecision = isAiHelper(command);
  if (helperDecision) return helperDecision;

  // Kimi WebBridge local browser automation — bypass path checks
  const webbridgeDecision = isKimiWebbridge(command);
  if (webbridgeDecision) return webbridgeDecision;

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

  const serverDecision = checkSafeServerCommands(command, mode);
  if (serverDecision) return serverDecision;

  const decision = decide(command, mode, sessionAllowedCommands);

  // Scope-aware downgrade for destructive/delete commands targeting only inside-project paths
  if (decision.action === "block") {
    const isDestructiveBlock =
      /destructive|delete/i.test(decision.reason || "") &&
      !/path traversal|protected directory/i.test(decision.reason || "");
    if (isDestructiveBlock) {
      const targets = extractBashPathTargets(command, cwd, loadWorkspaceRoots());
      if (targets.length > 0) {
        const allInside = targets.every((t) => t.scope === "inside_project");
        if (allInside) {
          if (mode === "relaxed" || mode === "yolo") {
            return {
              action: "allow",
              reason: "destructive command targets are inside current project/workspace",
            };
          }
          return {
            action: "ask",
            reason: `Destructive command inside current project/workspace requires confirmation\n\n${command}`,
          };
        }
      }
    }
  }

  // YOLO: safe read outside project is allowed; anything else outside project requires confirmation
  if (mode === "yolo" && decision.action === "allow") {
    const { body } = stripLeadingCd(command);
    const targets = extractBashPathTargets(body, cwd, loadWorkspaceRoots());
    const hasOutside = targets.some((t) => t.scope === "outside_project" || t.scope === "protected");
    if (hasOutside) {
      const analysis = analyze(command);
      if (isSafeReadBash(analysis)) {
        return { action: "allow" };
      }
      return {
        action: "ask",
        reason: `Command outside current project/workspace requires confirmation in yolo mode`,
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
