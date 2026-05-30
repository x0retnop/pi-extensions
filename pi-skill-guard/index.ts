import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXT = "pi-skill-guard";
const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "skillGuard";

let skillsEnabled: boolean;
let skillMap = new Map<string, { filePath: string; description: string }>();
let pendingInjections: Array<{ name: string; comment: string }> = [];

/* ─── Settings helpers ─── */

function loadSettings(): Record<string, unknown> {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function saveSettings(settings: Record<string, unknown>): void {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {}
}

function loadAutoSkills(): boolean {
  const settings = loadSettings();
  const sg = (settings[SETTINGS_KEY] as Record<string, unknown> | undefined) || {};
  return sg.autoSkills !== false;
}

function saveAutoSkills(enabled: boolean): void {
  const settings = loadSettings();
  settings[SETTINGS_KEY] = { ...(settings[SETTINGS_KEY] as Record<string, unknown> | undefined), autoSkills: enabled };
  saveSettings(settings);
}

/* ─── UI helper ─── */

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  const text = message.startsWith(`[${EXT}]`) ? message : `[${EXT}] ${message}`;
  if (ctx.hasUI && typeof (ctx.ui as any)?.notify === "function") {
    (ctx.ui as any).notify(text, level);
  }
}

/* ─── Skill discovery fallback ─── */

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

function discoverSkills(cwd: string): Map<string, { filePath: string; description: string }> {
  const map = new Map<string, { filePath: string; description: string }>();
  const dirs = [
    path.join(os.homedir(), ".pi", "agent", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(cwd, ".pi", "skills"),
    path.join(cwd, ".agents", "skills"),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const filePath = path.join(dir, entry.name);
        const { name, description } = parseSkillFrontmatter(filePath);
        if (name && !map.has(name)) map.set(name, { filePath, description });
      } else if (entry.isDirectory()) {
        const skillFile = path.join(dir, entry.name, "SKILL.md");
        if (fs.existsSync(skillFile)) {
          const { name, description } = parseSkillFrontmatter(skillFile);
          if (name && !map.has(name)) map.set(name, { filePath: skillFile, description });
        }
      }
    }
  }
  return map;
}

/* ─── Prompt helpers ─── */

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  return content.slice(end + 5).trimStart();
}

function removeSkillsBlock(prompt: string): string {
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

/* ─── Main ─── */

export default function (pi: ExtensionAPI) {
  skillsEnabled = loadAutoSkills();

  pi.on("session_start", (event, ctx) => {
    skillsEnabled = loadAutoSkills();
    skillMap = discoverSkills(ctx.cwd);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const skills = (event as any).systemPromptOptions?.skills as
      | Array<{ name: string; filePath: string; description: string }>
      | undefined;

    if (skills && skills.length > 0) {
      for (const s of skills) {
        if (!skillMap.has(s.name)) {
          skillMap.set(s.name, { filePath: s.filePath, description: s.description });
        }
      }
    }

    let systemPrompt = event.systemPrompt;

    if (!skillsEnabled) {
      systemPrompt = removeSkillsBlock(systemPrompt);
    }

    if (pendingInjections.length > 0) {
      for (const inj of pendingInjections) {
        const info = skillMap.get(inj.name);
        if (!info) continue;
        try {
          systemPrompt += buildSkillInjection(inj.name, info.filePath, inj.comment);
        } catch {
          // ignore read errors
        }
      }
      pendingInjections = [];
    }

    if (systemPrompt !== event.systemPrompt) {
      return { systemPrompt };
    }
    return undefined;
  });

  pi.registerCommand("skills", {
    description: "Show skill guard status and loaded skills",
    handler: async (_args, ctx) => {
      if (skillMap.size === 0) skillMap = discoverSkills(ctx.cwd);
      const status = skillsEnabled ? "ON" : "OFF";
      const lines = [`Auto-skills: ${status}`, `Loaded: ${skillMap.size}`];
      if (skillMap.size > 0) {
        lines.push("");
        for (const [name, info] of skillMap) {
          const desc = info.description.slice(0, 80) + (info.description.length > 80 ? "..." : "");
          lines.push(`- ${name}: ${desc}`);
        }
      }
      notify(ctx, lines.join("\n"), "info");
    },
  });

  pi.registerCommand("skills-toggle", {
    description: "Toggle automatic skill injection in the system prompt",
    handler: async (_args, ctx) => {
      skillsEnabled = !skillsEnabled;
      saveAutoSkills(skillsEnabled);
      notify(ctx, `Auto-skills ${skillsEnabled ? "ON" : "OFF"}`, "info");
    },
  });

  pi.registerCommand("use-skill", {
    description: "Inject a skill into the next turn. Run without args for an interactive picker.",
    getArgumentCompletions: (prefix: string) => {
      const matches = Array.from(skillMap.keys()).filter((n) => n.startsWith(prefix));
      return matches.map((name) => ({ label: name, value: name }));
    },
    handler: async (args, ctx) => {
      if (skillMap.size === 0) skillMap = discoverSkills(ctx.cwd);
      const trimmed = args.trim();

      // No args → show interactive picker and paste into editor
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

      // Parse name and optional comment
      const spaceIdx = trimmed.indexOf(" ");
      const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const comment = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (!skillMap.has(name)) {
        notify(ctx, `Skill not found: "${name}". Run /skills to see loaded skills.`, "error");
        return;
      }

      pendingInjections.push({ name, comment });
      pi.appendEntry("skill-guard", { type: "injection", name, comment, timestamp: Date.now() });
      notify(ctx, `Skill used: ${name}`, "info");

      // Launch the turn — the skill body goes into the system prompt via before_agent_start,
      // and the user's comment (or a placeholder) goes as the user message.
      if (comment) {
        pi.sendUserMessage(`[${name}] ${comment}`);
      } else {
        pi.sendUserMessage(`[${name}]`);
      }
    },
  });
}
