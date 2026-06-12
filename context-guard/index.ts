import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const EXT = "context-guard";
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "contextGuard";

interface GuardConfig {
  removeDate?: boolean;
  removeCwd?: boolean;
  removeAgentsWrapper?: boolean;
  removeAncestorAgents?: boolean;
  removeSkills?: boolean;
  removePiDocsBlock?: boolean;
  removeToolSnippets?: boolean;
  removeRoleOverride?: boolean;
}

const RULE_MAP: Record<string, keyof GuardConfig> = {
  date: "removeDate",
  cwd: "removeCwd",
  agents: "removeAgentsWrapper",
  "ancestor-agents": "removeAncestorAgents",
  skills: "removeSkills",
  "pi-docs": "removePiDocsBlock",
  "tool-snippets": "removeToolSnippets",
  "role-override": "removeRoleOverride",
};

const RULE_LABELS: Record<string, string> = {
  date: "Current date",
  cwd: "Current working directory",
  agents: "AGENTS.md XML wrapper",
  "ancestor-agents": "Ancestor AGENTS.md / CLAUDE.md files",
  skills: "Skills XML block",
  "pi-docs": "Default Pi docs block",
  "tool-snippets": "Tool snippets & Guidelines",
  "role-override": "Role Override (role-sw)",
};

/* ─── Settings helpers ─── */

function loadSettings(): any {
  try {
    if (existsSync(SETTINGS_PATH)) return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {}
  return {};
}

function saveSettings(settings: any): void {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {}
}

function loadConfig(): GuardConfig {
  return (loadSettings()[SETTINGS_KEY] as GuardConfig) || {};
}

function saveConfig(config: GuardConfig): void {
  const settings = loadSettings();
  settings[SETTINGS_KEY] = config;
  saveSettings(settings);
}

/* ─── Token estimate ─── */

function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

/* ─── Remove AGENTS.md / CLAUDE.md files loaded from ancestor directories ─── */

function normalizePathForCompare(p: string): string {
  return normalize(p).replace(/\\/g, "/").toLowerCase();
}

function removeAncestorAgents(prompt: string, cwd: string): string {
  const normalizedCwd = normalizePathForCompare(cwd);

  return prompt.replace(
    /<project_context>[\s\S]*?<\/project_context>/g,
    (match) => {
      const blockRegex = /<project_instructions path="([^"]*)">([\s\S]*?)<\/project_instructions>/g;
      const kept: string[] = [];
      let m: RegExpExecArray | null;

      while ((m = blockRegex.exec(match)) !== null) {
        const fileDir = normalizePathForCompare(dirname(m[1]));
        if (fileDir === normalizedCwd) {
          kept.push(m[0]);
        }
      }

      if (kept.length === 0) return "";

      let rebuilt = "<project_context>\n\n";
      rebuilt += "Project-specific instructions and guidelines:\n\n";
      for (const block of kept) {
        rebuilt += `${block}\n\n`;
      }
      rebuilt += "</project_context>";
      return rebuilt;
    },
  );
}

/* ─── Apply guard rules to system prompt text ─── */

function applyGuardRules(prompt: string, config: GuardConfig, cwd?: string): string {
  let result = prompt;

  if (config.removeAncestorAgents && cwd) {
    result = removeAncestorAgents(result, cwd);
  }

  if (config.removeDate) {
    result = result.replace(/\nCurrent date: [^\n]*/g, "");
  }

  if (config.removeCwd) {
    result = result.replace(/\nCurrent working directory: [^\n]*/g, "");
  }

  if (config.removeAgentsWrapper) {
    result = result.replace(/\n*<project_context>[\s\S]*?<\/project_context>\n*/g, "\n");
  }

  if (config.removeSkills) {
    result = result.replace(
      /\n*The following skills provide specialized instructions[\s\S]*?<\/available_skills>\n*/g,
      "\n",
    );
  }

  if (config.removeRoleOverride) {
    result = result.replace(/\n*## Role Override \([^)]+\)\n[\s\S]*?(?=\n## |\nCurrent date|$)/g, "\n");
  }

  if (config.removePiDocsBlock) {
    result = result.replace(
      /\n*Pi documentation \(read only when[\s\S]*?examples\/\)[^\n]*(?:\n-[^\n]*)*/g,
      "\n",
    );
  }

  if (config.removeToolSnippets) {
    result = result.replace(/\n*Available tools:\n[\s\S]*?(?=\n\n|$)/g, "\n");
    result = result.replace(/\n*Guidelines:\n[\s\S]*?(?=\n\n|$)/g, "\n");
  }

  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

/* ─── Find active role from session entries ─── */

function getActiveRoleFromEntries(entries: any[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as any;
    if (e?.type === "custom" && e?.customType === "role-switcher") {
      return e?.data?.role ?? null;
    }
  }
  return null;
}

function getRoleSize(name: string): number {
  try {
    const p = join(homedir(), ".pi", "agent", "roles", `${name}.md`);
    return estimateTokens(readFileSync(p, "utf-8"));
  } catch {
    return 0;
  }
}

/* ─── Build compact guard status ─── */

function buildGuardStatus(config: GuardConfig): string {
  const lines: string[] = [];
  lines.push("=== Context Guard Rules ===\n");
  for (const [rule, key] of Object.entries(RULE_MAP)) {
    const enabled = config[key] ?? false;
    lines.push(`  ${enabled ? "✓ ON " : "✗ OFF"}  ${rule.padEnd(15)} — ${RULE_LABELS[rule]}`);
  }
  lines.push("\nCommands:");
  lines.push("  /ctx-guard <rule>   toggle a rule");
  lines.push("  /ctx-guard reset    disable all rules");
  lines.push("  /ctx-inspect        full prompt breakdown");
  return lines.join("\n");
}

/* ─── Build inspection report ─── */

function buildInspectReport(
  systemPrompt: string,
  options: any,
  config: GuardConfig,
  entries: any[],
): string {
  const lines: string[] = [];
  lines.push("=== Context Guard Inspection ===\n");

  const cwd = options?.cwd;
  const effectivePrompt = applyGuardRules(systemPrompt, config, cwd);
  const rawTokens = estimateTokens(systemPrompt);
  const effectiveTokens = estimateTokens(effectivePrompt);
  const saved = rawTokens - effectiveTokens;

  lines.push("[Summary]");
  lines.push(`  Raw system prompt:    ~${rawTokens} tok`);
  lines.push(`  After guard rules:    ~${effectiveTokens} tok`);
  if (saved > 0) lines.push(`  Saved by guard:       ~${saved} tok`);

  // 1. Custom vs default
  const hasCustom = !!options?.customPrompt;
  lines.push(`\n[Prompt source] ${hasCustom ? "SYSTEM.md (custom)" : "Default Pi prompt"}`);
  if (hasCustom && options.customPrompt) {
    lines.push(`  ~${estimateTokens(options.customPrompt)} tok`);
  }

  // 2. Append
  const append = options?.appendSystemPrompt;
  lines.push(`\n[APPEND_SYSTEM.md] ${append ? `~${estimateTokens(append)} tok` : "(none)"}`);

  // 3. Context files
  const files = options?.contextFiles || [];
  if (files.length) {
    const total = files.reduce((a: number, f: any) => a + estimateTokens(f.content || ""), 0);
    let status: string;
    if (config.removeAgentsWrapper) {
      status = "WILL BE REMOVED";
    } else if (config.removeAncestorAgents && cwd) {
      const removed = files.filter((f: any) => normalizePathForCompare(dirname(f.path)) !== normalizePathForCompare(cwd)).length;
      status = removed > 0 ? `~${total} tok (${removed} ancestor file(s) will be removed)` : `~${total} tok`;
    } else {
      status = `~${total} tok`;
    }
    lines.push(`\n[AGENTS.md / CLAUDE.md] ${files.length} file(s) — ${status}`);
    for (const f of files) {
      const isAncestor = cwd && normalizePathForCompare(dirname(f.path)) !== normalizePathForCompare(cwd);
      const marker = config.removeAncestorAgents && isAncestor ? " [ancestor → removed]" : "";
      lines.push(`  - ${f.path} ~${estimateTokens(f.content || "")} tok${marker}`);
    }
  } else {
    lines.push("\n[AGENTS.md / CLAUDE.md] (none)");
  }

  // 4. Skills
  const skills = options?.skills || [];
  if (skills.length) {
    const status = config.removeSkills ? "WILL BE REMOVED" : `${skills.length} skill(s)`;
    lines.push(`\n[Skills] ${status}`);
    for (const s of skills) lines.push(`  - ${s.name}`);
  } else {
    lines.push("\n[Skills] (none)");
  }

  // 5. Active tools
  const tools = options?.selectedTools || [];
  lines.push(`\n[Active tools] ${tools.length}: ${tools.join(", ") || "(none)"}`);

  // 6. Default blocks
  if (!hasCustom) {
    const hasToolList = systemPrompt.includes("Available tools:");
    const hasGuidelines = systemPrompt.includes("Guidelines:");
    lines.push(`\n[Default prompt blocks]`);
    lines.push(`  Available tools: ${hasToolList ? (config.removeToolSnippets ? "WILL BE REMOVED" : "present") : "absent"}`);
    lines.push(`  Guidelines:    ${hasGuidelines ? (config.removeToolSnippets ? "WILL BE REMOVED" : "present") : "absent"}`);
  }

  // 7. Role override — check prompt + session entries
  const roleInPrompt = systemPrompt.match(/## Role Override \(([^)]+)\)/);
  if (roleInPrompt) {
    lines.push(`\n[Role override] ${roleInPrompt[1]} (already in base prompt)`);
  } else {
    const activeRole = getActiveRoleFromEntries(entries);
    if (activeRole) {
      const size = getRoleSize(activeRole);
      lines.push(`\n[Role override] ${activeRole} (~${size} tok) — added by role-sw each turn`);
    } else {
      lines.push("\n[Role override] (none)");
    }
  }

  // 8. Date / CWD
  const hasDate = systemPrompt.includes("Current date:");
  const hasCwd = systemPrompt.includes("Current working directory:");
  lines.push(`\n[Auto-injected stamps]`);
  lines.push(`  Current date: ${hasDate ? (config.removeDate ? "WILL BE REMOVED" : "PRESENT") : "ABSENT"}`);
  lines.push(`  Current working directory: ${hasCwd ? (config.removeCwd ? "WILL BE REMOVED" : "PRESENT") : "ABSENT"}`);

  // 9. Guard rules
  lines.push(`\n[Guard rules]`);
  for (const [rule, key] of Object.entries(RULE_MAP)) {
    const enabled = config[key] ?? false;
    lines.push(`  ${enabled ? "✓ ON " : "✗ OFF"}  ${rule.padEnd(15)} — ${RULE_LABELS[rule]}`);
  }

  return lines.join("\n");
}

/* ─── Main ─── */

export default function (pi: ExtensionAPI) {
  let config = loadConfig();

  pi.on("session_start", () => {
    config = loadConfig();
  });

  // Apply rules on every turn
  pi.on("before_agent_start", async (event, ctx) => {
    const original = event.systemPrompt ?? "";
    const cleaned = applyGuardRules(original, config, ctx.cwd);
    if (cleaned !== original) {
      return { systemPrompt: cleaned };
    }
    return undefined;
  });

  // /ctx-inspect — full breakdown
  pi.registerCommand("ctx-inspect", {
    description: "Inspect system prompt layers, auto-injections and guard rules",
    handler: async (_args, ctx) => {
      const prompt = (ctx as any).getSystemPrompt?.() ?? "";
      const options = (ctx as any).getSystemPromptOptions?.() ?? {};
      const entries = (ctx as any).sessionManager?.getEntries?.() ?? [];
      const report = buildInspectReport(prompt, options, config, entries);

      if (!ctx.hasUI) {
        console.log(report);
        return;
      }

      await ctx.ui.editor("ctx-inspect", report);
    },
  });

  // /ctx-guard — toggle rules
  pi.registerCommand("ctx-guard", {
    description:
      "Toggle context guard rules: date, cwd, agents, ancestor-agents, skills, pi-docs, tool-snippets, role-override",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const validRules = Object.keys(RULE_MAP);

      if (!arg || arg === "status") {
        const status = buildGuardStatus(config);
        if (ctx.hasUI) {
          await ctx.ui.editor("ctx-guard", status);
        } else {
          console.log(status);
        }
        return;
      }

      if (arg === "reset") {
        config = {};
        saveConfig(config);
        const msg = "All context guard rules reset (disabled).";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else console.log(msg);
        return;
      }

      if (!validRules.includes(arg)) {
        const msg = `Unknown rule "${arg}". Valid: ${validRules.join(", ")}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else console.error(msg);
        return;
      }

      const key = RULE_MAP[arg];
      const current = config[key] ?? false;
      config = { ...config, [key]: !current };
      saveConfig(config);

      const msg = `Guard rule "${arg}" (${RULE_LABELS[arg]}) → ${!current ? "ON" : "OFF"}`;
      if (ctx.hasUI) ctx.ui.notify(msg, "info");
      else console.log(msg);
    },
  });
}
