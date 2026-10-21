import { dirname, join, normalize } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { PROMPT_RULES, applyPromptRules, getActiveRoleFromEntries, getRoleSize } from "./prompt-rules.js";
import { MANAGED_FEATURES } from "./features.js";
import { getDumpSnapshot, getLastTurnUsage } from "./dump.js";
import { AGENTS_INJECT_TYPE, normalizeAgentsPath, readCwdAgentsFile } from "./agents-inject.js";
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
  const estimatedPrompt = applyPromptRules(systemPrompt, settings.promptRules, ctx);

  // Reality anchor: the FINAL system prompt captured from the actual provider
  // request (after ALL extensions, incl. role-sw, and after payload-level
  // guard enforcement). Falls back to our estimate before the first turn.
  const snapshot = getDumpSnapshot();
  const finalPrompt = snapshot.finalSystemPrompt;
  const effectivePrompt = finalPrompt ?? estimatedPrompt;

  lines.push("[Reality — what actually goes to the LLM]");
  if (finalPrompt !== undefined) {
    const when = new Date(snapshot.capturedAt).toLocaleTimeString();
    lines.push(`  Final system prompt (last provider request, ${when}):`);
    lines.push(`    ${finalPrompt.length.toLocaleString()} chars · ~${estimateTokens(finalPrompt).toLocaleString()} tok (chars/4 est.)`);
  } else {
    lines.push("  No provider request yet — figures below are Pi's BASE prompt");
    lines.push("  (SYSTEM.md canary + cwd), not the role the model will see.");
    lines.push(`  Base after guard rules: ~${estimateTokens(estimatedPrompt).toLocaleString()} tok`);
  }
  const lastUsage = getLastTurnUsage(entries);
  if (lastUsage) {
    const totalIn = lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite;
    lines.push(
      `  API-reported last turn: ${totalIn.toLocaleString()} tok in ` +
        `(fresh ${lastUsage.input.toLocaleString()}, cache read ${lastUsage.cacheRead.toLocaleString()}, cache write ${lastUsage.cacheWrite.toLocaleString()}) · ${lastUsage.output.toLocaleString()} out`,
    );
    lines.push("    ↑ ground truth from the provider; includes conversation + tool schemas, not just the system prompt");
  }

  const rawTokens = estimateTokens(systemPrompt);
  const effectiveTokens = estimateTokens(effectivePrompt);
  const saved = rawTokens - effectiveTokens;

  lines.push("\n[Summary]");
  lines.push(`  Base system prompt:     ~${rawTokens} tok`);
  lines.push(`  ${finalPrompt !== undefined ? "Final (real)" : "After guard rules"}:      ~${effectiveTokens} tok`);
  if (saved !== 0) lines.push(`  ${saved > 0 ? "Saved by guard + ext." : "Added downstream"}:  ~${Math.abs(saved)} tok`);

  const hasCustom = !!options?.customPrompt;
  lines.push(`\n[Prompt source] ${hasCustom ? "SYSTEM.md (custom)" : "Default Pi prompt"}`);
  if (hasCustom && options.customPrompt) {
    lines.push(`  ~${estimateTokens(options.customPrompt)} tok`);
  }

  const append = options?.appendSystemPrompt;
  lines.push(`\n[APPEND_SYSTEM.md] ${append ? `~${estimateTokens(append)} tok` : "(none)"}`);

  const files = options?.contextFiles || [];
  const cwd = options?.cwd as string | undefined;
  const injectOn = settings.agentsInject !== false;
  const injectAlready = entries.some((e: any) => e?.customType === AGENTS_INJECT_TYPE);
  const cwdAgents = cwd ? readCwdAgentsFile(cwd) : null;

  if (files.length) {
    const total = files.reduce((a: number, f: any) => a + estimateTokens(f.content || ""), 0);
    const rules = settings.promptRules;
    const removeAgents = rules["agents"] === false;
    const removeAncestor = rules["ancestorAgents"] === false;

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
    lines.push(`\n[AGENTS.md] in system prompt: ${files.length} file(s) — ${status}`);
    for (const f of files) {
      const isAncestor = cwd && normalizePathForCompare(dirname(f.path)) !== normalizePathForCompare(cwd);
      const marker = removeAncestor && isAncestor ? " [ancestor → removed]" : "";
      lines.push(`  - ${f.path} ~${estimateTokens(f.content || "")} tok${marker}`);
    }
  } else {
    lines.push("\n[AGENTS.md] not in system prompt");
  }
  if (!injectOn) {
    lines.push("  first-message: OFF");
  } else if (injectAlready) {
    lines.push("  first-message: already in this session");
  } else if (cwdAgents) {
    lines.push("  first-message: will send on this empty session");
  } else {
    lines.push("  first-message: ON, no cwd/AGENTS.md");
  }
  if (cwdAgents && injectOn) {
    lines.push(`  ${normalizeAgentsPath(cwdAgents.path)} ~${estimateTokens(cwdAgents.content)} tok`);
  }

  const skills = options?.skills || [];
  if (skills.length) {
    const status = settings.autoSkills === false ? "stripped by guard (auto-skills off)" : `${skills.length} skill(s)`;
    lines.push(`\n[Skills] ${status}`);
    for (const s of skills) lines.push(`  - ${s.name}`);
  } else {
    lines.push("\n[Skills] (none)");
  }

  const tools = options?.selectedTools || [];
  lines.push(`\n[Active tools] ${tools.length}: ${tools.join(", ") || "(none)"}`);

  if (!hasCustom) {
    const hasToolList = effectivePrompt.includes("Available tools:");
    const hasGuidelines = effectivePrompt.includes("Guidelines:");
    const rules = settings.promptRules;
    lines.push(`\n[Default prompt blocks]`);
    lines.push(`  Available tools: ${hasToolList ? "present" : rules["toolSnippets"] === false ? "stripped by guard" : "absent"}`);
    lines.push(`  Guidelines:      ${hasGuidelines ? "present" : rules["toolSnippets"] === false ? "stripped by guard" : "absent"}`);
  }

  const activeRole = getActiveRoleFromEntries(entries);
  if (activeRole) {
    const size = getRoleSize(activeRole);
    const stripped = settings.promptRules["roleOverride"] === false;
    const sizeBit = size > 0 ? `~${size} tok` : "file not found";
    let fate: string;
    if (stripped) fate = "stripped by guard";
    else if (finalPrompt !== undefined) fate = "in the last provider request";
    else fate = "role-sw replaces SYSTEM.md canary";
    lines.push(`\n[Role] ${activeRole} (${sizeBit}) — ${fate}`);
  } else {
    lines.push("\n[Role] (none)");
  }

  const hasDate = effectivePrompt.includes("Current date:");
  const hasCwd = effectivePrompt.includes("Current working directory:");
  const rules = settings.promptRules;
  lines.push(`\n[Stamps]`);
  lines.push(`  date: ${hasDate ? "in prompt" : rules["date"] === false ? "OFF" : "not in prompt"}`);
  lines.push(`  cwd:  ${hasCwd ? "in prompt" : rules["cwd"] === false ? "OFF" : "not in prompt"}`);

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
  lines.push(`  ${settings.agentsInject !== false ? "✓ ON " : "✗ OFF"}  agentsInject    — First-message AGENTS.md`);

  return lines.join("\n");
}
