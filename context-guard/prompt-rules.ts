import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { PromptRule, PromptRuleContext } from "./types.js";
import { resolveRoleFileIn } from "../role-sw/roles.js";

function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

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
  const dirs = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "role-sw", "roles"),
    join(homedir(), ".pi", "agent", "extensions", "role-sw", "roles"),
    join(homedir(), ".pi", "agent", "roles"),
  ];
  for (const dir of dirs) {
    // Shared resolver: `agent-core` and a stale session's `agent-core-v3` both
    // land on the newest file of the family, so the size matches what is sent.
    const file = resolveRoleFileIn(dir, name);
    if (!file) continue;
    try {
      return estimateTokens(readFileSync(file, "utf-8"));
    } catch {
      // unreadable — try the next directory
    }
  }
  return 0;
}

export const PROMPT_RULES: PromptRule[] = [
  {
    id: "date",
    label: "Date stamp (YYYY-MM-DD)",
    description:
      "Append `Current date: YYYY-MM-DD` to the system prompt. Pi >= 0.80.7 no longer adds it (cross-day cache bust). Day granularity only: time-of-day would change the prompt every turn and destroy the prompt cache — use `date` in bash for the clock.",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (!enabled) {
        return prompt.replace(/\nCurrent date: [^\n]*/g, "");
      }
      if (/^Current date: /m.test(prompt)) return prompt;
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      return `${prompt}\nCurrent date: ${stamp}`;
    },
  },
  {
    id: "cwd",
    label: "Workdir stamp in prompt",
    description: "Injected `Current working directory: …` line before every LLM call (not the shell cwd itself).",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (enabled) return prompt;
      return prompt.replace(/\nCurrent working directory: [^\n]*/g, "");
    },
  },
  {
    id: "agents",
    label: "Project AGENTS.md / CLAUDE.md",
    description: "Project context instructions wrapper (`<project_context>`).",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (enabled) return prompt;
      return prompt.replace(/\n*<project_context>[\s\S]*?<\/project_context>\n*/g, "\n");
    },
  },
  {
    id: "ancestorAgents",
    label: "Parent-folder AGENTS.md",
    description: "When ON, keep ancestor AGENTS/CLAUDE from parent folders. When OFF, only the file from the current directory.",
    defaultEnabled: true,
    apply: (prompt, ctx, enabled) => {
      if (enabled || !ctx.cwd) return prompt;
      return removeAncestorAgents(prompt, ctx.cwd);
    },
  },
  {
    id: "piDocs",
    label: "Pi docs block",
    description: "Built-in Pi documentation / examples block in the system prompt.",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (enabled) return prompt;
      return prompt.replace(
        /\n*Pi documentation \(read only when[^\n]*(?:\n-[^\n]*)*/g,
        "\n",
      );
    },
  },
  {
    id: "toolSnippets",
    label: "Tool list & guidelines",
    description: "`Available tools:` list and `Guidelines:` text in the system prompt.",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (enabled) return prompt;
      let result = prompt.replace(/\n*Available tools:\n[\s\S]*?(?=\n\n|$)/g, "\n");
      result = result.replace(/\n*Guidelines:\n[\s\S]*?(?=\n\n|$)/g, "\n");
      return result;
    },
  },
  {
    id: "roleOverride",
    label: "Role text (role-sw)",
    description:
      "Injected custom role markdown from role-sw. role-sw runs AFTER context-guard's before_agent_start, " +
      "so this rule is enforced at the provider payload level (before_provider_request) — the OFF state is real.",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (enabled) return prompt;
      return prompt.replace(/\n*## Role Override \([^)]*\)\n[\s\S]*?(?=\n## |\nCurrent date|$)/g, "\n");
    },
  },
];

export function applyPromptRules(prompt: string, rules: Record<string, boolean>, ctx: PromptRuleContext): string {
  let result = prompt;
  for (const rule of PROMPT_RULES) {
    const enabled = rules[rule.id] ?? rule.defaultEnabled;
    result = rule.apply(result, ctx, enabled);
  }
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

/**
 * Removal-only pass: applies just the disabled rules' strip behavior plus
 * whitespace normalization. Never appends (the `date` rule's append is a
 * before_agent_start concern). Used for idempotent payload-level enforcement,
 * where re-appending would duplicate content.
 */
export function stripPromptRules(prompt: string, rules: Record<string, boolean>, ctx: PromptRuleContext): string {
  let result = prompt;
  for (const rule of PROMPT_RULES) {
    const enabled = rules[rule.id] ?? rule.defaultEnabled;
    if (!enabled) result = rule.apply(result, ctx, false);
  }
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

export { getActiveRoleFromEntries, getRoleSize };
