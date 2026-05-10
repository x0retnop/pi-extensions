import { tokenize } from "./tokenizer.js";
import { analyzeCommand } from "./analyzer.js";
import type { Decision, GateMode, AnalyzedCommand } from "./types.js";

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

const SAFE_TEMP_PATTERNS = [
  /^\s*(?:del|erase)(?:\s+\/[a-z]+)*\s+[\"']?(?:\.[\\/])?_temp\.py[\"']?\s*$/i,
  /^\s*rm(?:\s+-f)?\s+[\"']?(?:\.[\\/])?_temp\.py[\"']?\s*$/i,
  /^\s*Remove-Item(?:\s+-(?:Force|LiteralPath|Path))*\s+[\"']?(?:\.[\\/])?_temp\.py[\"']?(?:\s+-(?:Force))*\s*$/i,
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

export function decide(
  command: string,
  mode: GateMode,
  sessionAllowedCommands: Set<string>
): Decision {
  const normalized = normalizeCommand(command);

  // 1. Exact command session approval
  if (sessionAllowedCommands.has(normalized)) {
    return { action: "allow" };
  }

  // 2. Safe temp file deletion heuristic
  if (isSafeTempDelete(command)) {
    return { action: "allow" };
  }

  // 3. Structural analysis
  const analysis = analyze(command);

  // 4. Hard block: destructive always blocked
  if (analysis.risk === "destructive") {
    return {
      action: "block",
      reason: `Blocked destructive command (${analysis.categories.join(", ")})`,
    };
  }

  // YOLO override: install/delete always ask even if DB marks them yolo-auto-allow
  if (mode === "yolo" && (analysis.risk === "install" || analysis.risk === "delete")) {
    return {
      action: "ask",
      reason: `${analysis.risk} command requires confirmation in yolo mode`,
    };
  }

  // 5. Auto-allow if every segment is either explicitly allowed by DB
  // or falls below the ask threshold for this mode.
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

  // 6. Fallback mode-based rules for the overall command
  if (!fallbackNeedsAsk(analysis.risk, mode)) {
    return { action: "allow" };
  }

  return {
    action: "ask",
    reason: `${analysis.risk} command requires confirmation in ${mode} mode`,
  };
}

export async function askAllowOnceOrSession(
  ctx: any,
  message: string
): Promise<"once" | "command" | "block"> {
  if (!ctx?.hasUI) return "block";

  const choices = ["Allow once", "Always allow exact command this session", "Block"];
  const choice = await ctx.ui.select(message, choices);

  if (choice === "Allow once") return "once";
  if (choice === "Always allow exact command this session") return "command";
  return "block";
}
