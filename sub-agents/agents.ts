import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNonNegativeInt, parsePositiveInt } from "./util.js";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  includeExtensions?: boolean;
  extensions?: string[];
  role?: string;
  /** Hard wall-clock ceiling for one attempt (ms). */
  timeoutMs?: number;
  /** Hard assistant-turn ceiling for one attempt. */
  maxTurns?: number;
  /** Soft deadline (ms): stops a run that completes no turn for this long. */
  deadlineMs?: number;
  /** No stdout at all for this long, with no tool running (ms). */
  idleMs?: number;
  /** No stdout at all for this long while a tool runs (ms). */
  toolIdleMs?: number;
  /** Stop at this share of the child's context window (percent). 0 disables. */
  contextLimitPercent?: number;
  /** How many times a fired hard/turn cap is extended (+50% each) on recent progress. 0 = never extend. */
  maxExtensions?: number;
  /** A cap extends only if a turn completed within this window (ms). */
  extendGraceMs?: number;
  /** If true, the agent is reserved for internal slash commands and is not exposed in the TUI or `spawn_agent`. */
  hidden?: boolean;
  systemPrompt: string;
  source: "project" | "builtin";
  filePath: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
  model?: string;
  tools?: string;
  includeExtensions?: string;
  extensions?: string;
  role?: string;
  timeoutMs?: string;
  maxTurns?: string;
  deadlineMs?: string;
  idleMs?: string;
  toolIdleMs?: string;
  contextLimitPercent?: string;
  maxExtensions?: string;
  extendGraceMs?: string;
  hidden?: string;
  [key: string]: string | undefined;
}

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const BUILTIN_AGENTS_DIR = EXTENSION_DIR;
// Agents are loaded from the extension root only.

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    frontmatter[key] = value;
  }
  const body = match[2].trimStart().replace(/<!--[\s\S]*?-->/g, "").trimStart();
  return { frontmatter, body };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function loadAgentsFromDir(dir: string, source: "project" | "builtin"): Promise<AgentConfig[]> {
  const agents: AgentConfig[] = [];
  if (!(await isDirectory(dir))) return agents;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return agents;
  }

  for (const name of entries.filter((f) => f.endsWith(".md"))) {
    const filePath = join(dir, name);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ? frontmatter.tools
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    const extensions = frontmatter.extensions
      ? frontmatter.extensions
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean)
      : undefined;

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      model: frontmatter.model,
      tools,
      includeExtensions: frontmatter.includeExtensions?.toLowerCase() === "true",
      extensions,
      role: frontmatter.role || undefined,
      timeoutMs: parsePositiveInt(frontmatter.timeoutMs),
      maxTurns: parsePositiveInt(frontmatter.maxTurns),
      deadlineMs: parsePositiveInt(frontmatter.deadlineMs),
      idleMs: parsePositiveInt(frontmatter.idleMs),
      toolIdleMs: parsePositiveInt(frontmatter.toolIdleMs),
      contextLimitPercent: parseNonNegativeInt(frontmatter.contextLimitPercent),
      maxExtensions: parseNonNegativeInt(frontmatter.maxExtensions),
      extendGraceMs: parsePositiveInt(frontmatter.extendGraceMs),
      hidden: frontmatter.hidden?.toLowerCase() === "true",
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

export async function loadBuiltinAgents(): Promise<AgentConfig[]> {
  return loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
}

export function visibleAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter((a) => !a.hidden);
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("\n");
}
