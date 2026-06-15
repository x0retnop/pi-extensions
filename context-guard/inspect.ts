import { dirname, join, normalize } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { PROMPT_RULES, applyPromptRules, getActiveRoleFromEntries, getRoleSize } from "./prompt-rules.js";
import { MANAGED_FEATURES, getFeatureById } from "./features.js";
import type { GuardSettings, PromptRuleContext } from "./types.js";

function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

function normalizePathForCompare(p: string): string {
  return normalize(p).replace(/\\/g, "/").toLowerCase();
}

export function buildInspectReport(
  systemPrompt: string,
  options: any,
  settings: GuardSettings,
  entries: any[],
): string {
  const lines: string[] = [];
  lines.push("=== Context Guard Inspection ===\n");

  const ctx: PromptRuleContext = { cwd: options?.cwd, options, entries };
  const effectivePrompt = applyPromptRules(systemPrompt, settings.promptRules, ctx);
  const rawTokens = estimateTokens(systemPrompt);
  const effectiveTokens = estimateTokens(effectivePrompt);
  const saved = rawTokens - effectiveTokens;

  lines.push("[Summary]");
  lines.push(`  Raw system prompt:    ~${rawTokens} tok`);
  lines.push(`  After guard rules:    ~${effectiveTokens} tok`);
  if (saved > 0) lines.push(`  Saved by guard:       ~${saved} tok`);

  const hasCustom = !!options?.customPrompt;
  lines.push(`\n[Prompt source] ${hasCustom ? "SYSTEM.md (custom)" : "Default Pi prompt"}`);
  if (hasCustom && options.customPrompt) {
    lines.push(`  ~${estimateTokens(options.customPrompt)} tok`);
  }

  const append = options?.appendSystemPrompt;
  lines.push(`\n[APPEND_SYSTEM.md] ${append ? `~${estimateTokens(append)} tok` : "(none)"}`);

  const files = options?.contextFiles || [];
  if (files.length) {
    const total = files.reduce((a: number, f: any) => a + estimateTokens(f.content || ""), 0);
    const rules = settings.promptRules;
    const removeAgents = rules["agents"] === false;
    const removeAncestor = rules["ancestorAgents"] === false;
    const cwd = options?.cwd;

    let status: string;
    if (removeAgents) {
      status = "WILL BE REMOVED";
    } else if (removeAncestor && cwd) {
      const removed = files.filter(
        (f: any) => normalizePathForCompare(dirname(f.path)) !== normalizePathForCompare(cwd),
      ).length;
      status = removed > 0 ? `~${total} tok (${removed} ancestor file(s) will be removed)` : `~${total} tok`;
    } else {
      status = `~${total} tok`;
    }
    lines.push(`\n[AGENTS.md / CLAUDE.md] ${files.length} file(s) — ${status}`);
    for (const f of files) {
      const isAncestor = cwd && normalizePathForCompare(dirname(f.path)) !== normalizePathForCompare(cwd);
      const marker = removeAncestor && isAncestor ? " [ancestor → removed]" : "";
      lines.push(`  - ${f.path} ~${estimateTokens(f.content || "")} tok${marker}`);
    }
  } else {
    lines.push("\n[AGENTS.md / CLAUDE.md] (none)");
  }

  const skills = options?.skills || [];
  if (skills.length) {
    const status = settings.autoSkills === false ? "WILL BE REMOVED (auto-skills off)" : `${skills.length} skill(s)`;
    lines.push(`\n[Skills] ${status}`);
    for (const s of skills) lines.push(`  - ${s.name}`);
  } else {
    lines.push("\n[Skills] (none)");
  }

  const tools = options?.selectedTools || [];
  lines.push(`\n[Active tools] ${tools.length}: ${tools.join(", ") || "(none)"}`);

  if (!hasCustom) {
    const hasToolList = systemPrompt.includes("Available tools:");
    const hasGuidelines = systemPrompt.includes("Guidelines:");
    const rules = settings.promptRules;
    lines.push(`\n[Default prompt blocks]`);
    lines.push(`  Available tools: ${hasToolList ? (rules["toolSnippets"] === false ? "WILL BE REMOVED" : "present") : "absent"}`);
    lines.push(`  Guidelines:    ${hasGuidelines ? (rules["toolSnippets"] === false ? "WILL BE REMOVED" : "present") : "absent"}`);
  }

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

  const hasDate = systemPrompt.includes("Current date:");
  const hasCwd = systemPrompt.includes("Current working directory:");
  const rules = settings.promptRules;
  lines.push(`\n[Auto-injected stamps]`);
  lines.push(`  Current date: ${hasDate ? (rules["date"] === false ? "WILL BE REMOVED" : "PRESENT") : "ABSENT"}`);
  lines.push(`  Current working directory: ${hasCwd ? (rules["cwd"] === false ? "WILL BE REMOVED" : "PRESENT") : "ABSENT"}`);

  lines.push(`\n[Guard rules]`);
  for (const rule of PROMPT_RULES) {
    const enabled = rules[rule.id] ?? rule.defaultEnabled;
    lines.push(`  ${enabled ? "✓ ON " : "✗ OFF"}  ${rule.id.padEnd(15)} — ${rule.label}`);
  }

  lines.push(`\n[Tool gates]`);
  for (const feature of MANAGED_FEATURES) {
    if (feature.category !== "tools") continue;
    const enabled = settings.features[feature.id] ?? feature.defaultEnabled;
    lines.push(`  ${enabled ? "✓ ON " : "✗ OFF"}  ${feature.id.padEnd(15)} — ${feature.label}`);
  }

  lines.push(`\n[Skills]`);
  lines.push(`  ${settings.autoSkills !== false ? "✓ ON " : "✗ OFF"}  auto-skills     — Automatic skill injection`);

  return lines.join("\n");
}
