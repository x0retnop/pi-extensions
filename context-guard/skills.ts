import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXT = "context-guard";
const SKILL_DIRS = [
  () => path.join(os.homedir(), ".pi", "agent", "skills"),
  () => path.join(os.homedir(), ".agents", "skills"),
  (cwd: string) => path.join(cwd, ".pi", "skills"),
  (cwd: string) => path.join(cwd, ".agents", "skills"),
];

export interface SkillInfo {
  name: string;
  filePath: string;
  description: string;
}

let skillMap = new Map<string, SkillInfo>();
let pendingInjections: Array<{ name: string; comment: string }> = [];

function parseSkillFrontmatter(filePath: string): { name: string; description: string } {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.startsWith("---\n")) {
      return { name: path.basename(filePath, ".md"), description: "" };
    }
    const end = content.indexOf("\n---\n", 4);
    if (end === -1) return { name: path.basename(filePath, ".md"), description: "" };
    const fm = content.slice(4, end);
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || path.basename(filePath, ".md");
    const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
    return { name, description };
  } catch {
    return { name: path.basename(filePath, ".md"), description: "" };
  }
}

export function discoverSkills(cwd: string): Map<string, SkillInfo> {
  const map = new Map<string, SkillInfo>();
  const dirs = SKILL_DIRS.map((fn) => fn(cwd)).filter((p) => typeof p === "string");

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const filePath = path.join(dir, entry.name);
        const { name, description } = parseSkillFrontmatter(filePath);
        if (name && !map.has(name)) map.set(name, { name, filePath, description });
      } else if (entry.isDirectory()) {
        const skillFile = path.join(dir, entry.name, "SKILL.md");
        if (fs.existsSync(skillFile)) {
          const { name, description } = parseSkillFrontmatter(skillFile);
          if (name && !map.has(name)) map.set(name, { name, filePath: skillFile, description });
        }
      }
    }
  }
  return map;
}

export function ensureSkillsDiscovered(cwd: string): Map<string, SkillInfo> {
  if (skillMap.size === 0) {
    skillMap = discoverSkills(cwd);
  }
  return skillMap;
}

export function refreshSkills(cwd: string): Map<string, SkillInfo> {
  skillMap = discoverSkills(cwd);
  return skillMap;
}

export function getSkillMap(): Map<string, SkillInfo> {
  return skillMap;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  return content.slice(end + 5).trimStart();
}

export function removeSkillsBlock(prompt: string): string {
  const idx = prompt.indexOf("\n\nThe following skills provide specialized instructions");
  if (idx === -1) return prompt;
  const endIdx = prompt.indexOf("</available_skills>", idx);
  if (endIdx === -1) return prompt;
  return prompt.slice(0, idx) + prompt.slice(endIdx + "</available_skills>".length);
}

function buildSkillInjection(name: string, filePath: string, comment: string): string {
  const raw = fs.readFileSync(filePath, "utf-8");
  const body = stripFrontmatter(raw);
  let text = `\n\n## Skill: ${name}\n\n${body}`;
  if (comment) {
    text += `\n\nUser request: ${comment}`;
  }
  return text;
}

export function injectPendingSkills(prompt: string): string {
  if (pendingInjections.length === 0) return prompt;
  let result = prompt;
  for (const inj of pendingInjections) {
    const info = skillMap.get(inj.name);
    if (!info) continue;
    try {
      result += buildSkillInjection(inj.name, info.filePath, inj.comment);
    } catch {
      // ignore read errors
    }
  }
  pendingInjections = [];
  return result;
}

export function queueSkillInjection(name: string, comment: string): boolean {
  if (!skillMap.has(name)) return false;
  pendingInjections.push({ name, comment });
  return true;
}

export function buildSkillStatus(autoSkills: boolean): string {
  const lines = [`Auto-skills: ${autoSkills ? "ON" : "OFF"}`, `Discovered: ${skillMap.size}`];
  if (skillMap.size > 0) {
    lines.push("");
    for (const [name, info] of skillMap) {
      const desc = info.description.slice(0, 80) + (info.description.length > 80 ? "..." : "");
      lines.push(`- ${name}: ${desc}`);
    }
  }
  return lines.join("\n");
}

export function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  const text = message.startsWith(`[${EXT}]`) ? message : `[${EXT}] ${message}`;
  if (ctx.hasUI && typeof (ctx.ui as any)?.notify === "function") {
    (ctx.ui as any).notify(text, level);
  } else {
    const log = level === "error" ? console.error : console.log;
    log(text);
  }
}

export function registerSkillCommands(pi: ExtensionAPI): void {
  pi.registerCommand("skills", {
    description: "Show skill guard status and loaded skills",
    handler: async (_args, ctx) => {
      ensureSkillsDiscovered(ctx.cwd);
      // autoSkills state is held in guard settings; we emit what we know from the current runtime state via notify.
      notify(ctx, buildSkillStatus(true), "info");
    },
  });

  pi.registerCommand("use-skill", {
    description: "Inject a skill into the next turn. Run without args for an interactive picker.",
    getArgumentCompletions: (prefix: string) => {
      const matches = Array.from(skillMap.keys()).filter((n) => n.startsWith(prefix));
      return matches.map((name) => ({ label: name, value: name }));
    },
    handler: async (args, ctx) => {
      ensureSkillsDiscovered(ctx.cwd);
      const trimmed = args.trim();

      if (!trimmed) {
        const names = Array.from(skillMap.keys());
        if (names.length === 0) {
          notify(ctx, "No skills loaded.", "warning");
          return;
        }
        const name = await ctx.ui.select("Select skill to inject", names);
        if (!name) return;
        ctx.ui.pasteToEditor(`/use-skill ${name} `);
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const comment = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (!skillMap.has(name)) {
        notify(ctx, `Skill not found: "${name}". Run /skills to see loaded skills.`, "error");
        return;
      }

      queueSkillInjection(name, comment);
      pi.appendEntry("skill-guard", { type: "injection", name, comment, timestamp: Date.now() });
      notify(ctx, `Skill used: ${name}`, "info");

      if (comment) {
        pi.sendUserMessage(`[${name}] ${comment}`);
      } else {
        pi.sendUserMessage(`[${name}]`);
      }
    },
  });
}
