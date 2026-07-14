import { dirname, join, normalize } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { PromptRule, PromptRuleContext } from "./types.js";

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
  try {
    const p = join(homedir(), ".pi", "agent", "roles", `${name}.md`);
    return estimateTokens(readFileSync(p, "utf-8"));
  } catch {
    return 0;
  }
}

export const PROMPT_RULES: PromptRule[] = [
  {
    id: "date",
    label: "Current date",
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
    label: "Current working directory",
    description: "Injected CWD before every LLM call.",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (enabled) return prompt;
      return prompt.replace(/\nCurrent working directory: [^\n]*/g, "");
    },
  },
  {
    id: "agents",
    label: "AGENTS.md / CLAUDE.md XML wrapper",
    description: "Project context instructions wrapper.",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (enabled) return prompt;
      return prompt.replace(/\n*<project_context>[\s\S]*?<\/project_context>\n*/g, "\n");
    },
  },
  {
    id: "ancestorAgents",
    label: "Ancestor AGENTS.md / CLAUDE.md files",
    description: "Keep only the context file from the current directory.",
    defaultEnabled: true,
    apply: (prompt, ctx, enabled) => {
      if (enabled || !ctx.cwd) return prompt;
      return removeAncestorAgents(prompt, ctx.cwd);
    },
  },
  {
    id: "skills",
    label: "Skills XML block",
    description: "Automatic available_skills listing in system prompt.",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (enabled) return prompt;
      return prompt.replace(
        /\n*The following skills provide specialized instructions[\s\S]*?<\/available_skills>\n*/g,
        "\n",
      );
    },
  },
  {
    id: "piDocs",
    label: "Default Pi docs block",
    description: "Built-in Pi documentation / examples block.",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (enabled) return prompt;
      return prompt.replace(
        /\n*Pi documentation \(read only when[\s\S]*?examples\/\)[^\n]*(?:\n-[^\n]*)*/g,
        "\n",
      );
    },
  },
  {
    id: "toolSnippets",
    label: "Tool snippets & Guidelines",
    description: "Available tools list and guidelines text.",
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
    label: "Role Override (role-sw)",
    description: "Injected custom role markdown from role-sw.",
    defaultEnabled: true,
    apply: (prompt, _ctx, enabled) => {
      if (enabled) return prompt;
      return prompt.replace(/\n*## Role Override \([^)]*\)\n[\s\S]*?(?=\n## |\nCurrent date|$)/g, "\n");
    },
  },
];

export function getPromptRuleDefaults(): Record<string, boolean> {
  return Object.fromEntries(PROMPT_RULES.map((r) => [r.id, r.defaultEnabled]));
}

export function applyPromptRules(prompt: string, rules: Record<string, boolean>, ctx: PromptRuleContext): string {
  let result = prompt;
  for (const rule of PROMPT_RULES) {
    const enabled = rules[rule.id] ?? rule.defaultEnabled;
    result = rule.apply(result, ctx, enabled);
  }
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

export { getActiveRoleFromEntries, getRoleSize };
