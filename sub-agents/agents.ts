import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  includeExtensions?: boolean;
  extensions?: string[];
  timeoutMs?: number;
  maxTurns?: number;
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
  timeoutMs?: string;
  maxTurns?: string;
  [key: string]: string | undefined;
}

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const BUILTIN_AGENTS_DIR = EXTENSION_DIR;
// Agents are loaded directly from cwd (*.md) or from the extension root as fallback.

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
  return { frontmatter, body: match[2].trimStart() };
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
      timeoutMs: frontmatter.timeoutMs ? Number(frontmatter.timeoutMs) : undefined,
      maxTurns: frontmatter.maxTurns ? Number(frontmatter.maxTurns) : undefined,
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

export async function discoverAgents(cwd: string): Promise<AgentConfig[]> {
  const cwdAgents = await loadAgentsFromDir(cwd, "project");
  if (cwdAgents.length > 0) {
    return cwdAgents;
  }
  return loadBuiltinAgents();
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("\n");
}
