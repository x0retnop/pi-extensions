import { readFile, stat, readdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve roles/ directory relative to this module.
// Works for both direct file loading and directory-based extension loading.
function getRolesDir(): string {
  const modulePath = fileURLToPath(import.meta.url);
  return join(dirname(modulePath), "roles");
}

export const ROLES_DIR = getRolesDir();

/** Selectable `/role` files. `_*.md` and README are fragments, not roles. */
export function isSelectableRoleFile(filename: string): boolean {
  if (!filename.endsWith(".md")) return false;
  if (filename.startsWith("_")) return false;
  return filename.toLowerCase() !== "readme.md";
}

interface CacheEntry {
  content: string;
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Version suffix of a role file. Must be the last token: `agent-core-v4` is a
 * family+version, `sub-ds-v4-flash` is a plain name.
 */
const VERSIONED_RE = /^(.+)-v(\d+)$/i;

/** Family alias of a role name: `agent-core-v4` → `agent-core`. Plain names are their own family. */
export function roleFamily(name: string): string {
  const m = VERSIONED_RE.exec(name);
  return m ? m[1] : name;
}

/** Selectable role stems on disk, unnormalized and unsorted (`agent-core-v4`, `blank`, …). */
function listRoleStems(dir: string = ROLES_DIR): string[] {
  try {
    return readdirSync(dir).filter(isSelectableRoleFile).map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

/** Highest `-v<N>` of `alias` among `stems`, or null. Numeric compare: v10 > v9. */
function newestFamilyStem(alias: string, stems: string[]): string | null {
  let best: string | null = null;
  let bestVersion = -1;
  for (const stem of stems) {
    const m = VERSIONED_RE.exec(stem);
    if (!m || m[1].toLowerCase() !== alias.toLowerCase()) continue;
    const version = Number(m[2]);
    if (version > bestVersion || (version === bestVersion && best !== null && stem > best)) {
      bestVersion = version;
      best = stem;
    }
  }
  return best;
}

/**
 * Resolve `name` to a role file inside `dir`.
 * - unversioned name with a matching file → that file (wins over `name-v<N>` siblings);
 * - otherwise → the newest `-v<N>` of the family.
 * Versioned names never pin: `agent-core-v3` resolves to the newest file of
 * `agent-core`, so old session entries and settings follow version bumps.
 */
export function resolveRoleFileIn(dir: string, name: string): string | null {
  const clean = name.trim().replace(/\.md$/i, "").replace(/^.*[\\/]/, "");
  if (!clean) return null;
  const stems = listRoleStems(dir);
  const alias = roleFamily(clean);
  if (alias === clean && stems.includes(clean)) return join(dir, `${clean}.md`);
  const stem = newestFamilyStem(alias, stems);
  return stem ? join(dir, `${stem}.md`) : null;
}

export interface RoleRef {
  /** Concrete role name (file stem) that will be read — e.g. `agent-core-v4`. */
  name: string;
  /** Family alias, e.g. `agent-core`. Equals `name` for unversioned roles. */
  alias: string;
  /** Absolute path of the role file. */
  path: string;
}

/** Resolve a role name to the file that will actually be read. Null when nothing matches. */
export function resolveRole(name: string): RoleRef | null {
  const file = resolveRoleFileIn(ROLES_DIR, name);
  if (!file) return null;
  const stem = basename(file, ".md");
  return { name: stem, alias: roleFamily(stem), path: file };
}

/**
 * Selectable roles as family aliases: one entry per family, not per version.
 * `agent-core-v1…v4` → `agent-core`; `blank` stays `blank`.
 */
export async function getAvailableRoles(): Promise<string[]> {
  return [...new Set(listRoleStems().map(roleFamily))].sort();
}

export async function getLatestRole(): Promise<string | null> {
  try {
    const files = await readdir(ROLES_DIR, { withFileTypes: true });
    let latestName: string | null = null;
    let latestMtime = 0;

    for (const entry of files) {
      if (!entry.isFile()) continue;
      const f = entry.name;
      if (!isSelectableRoleFile(f)) continue;

      const path = join(ROLES_DIR, f);
      try {
        const s = await stat(path);
        const mtime = s.mtime.getTime();
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestName = f.slice(0, -3);
        }
      } catch {}
    }

    return latestName;
  } catch {
    return null;
  }
}

export function resolveRolePath(name: string): string {
  return join(ROLES_DIR, `${name}.md`);
}

export function resolveIncludePath(name: string, dir: string = ROLES_DIR): string {
  return join(dir, name);
}

/**
 * Strip a leading YAML front-matter block (---\n...\n---) if present.
 * Role files may carry `name`/`description` metadata that must not leak
 * into the system prompt composed for sub-agents.
 */
export function stripFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return text;
  return text.slice(match[0].length);
}

export async function readFileCached(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    const cached = cache.get(path);
    if (cached && cached.mtime === s.mtime.getTime()) {
      return cached.content;
    }
    const content = stripFrontmatter(await readFile(path, "utf-8"));
    cache.set(path, { content, mtime: s.mtime.getTime() });
    return content;
  } catch {
    return null;
  }
}

const INCLUDE_RE = /^\{\{include:\s*(.+?)\s*\}\}\s*$/gm;

export async function resolveIncludes(text: string, visited = new Set<string>()): Promise<string> {
  const matches = [...text.matchAll(INCLUDE_RE)];
  if (matches.length === 0) return text;

  // Positional assembly, not sequential replace: string-replace interprets
  // `$&`/`$1`/`$$` in fragment content and re-replaces the wrong occurrence
  // when the same marker appears twice.
  let result = "";
  let last = 0;
  for (const m of matches) {
    result += text.slice(last, m.index);
    const includeName = m[1];
    const includePath = resolveIncludePath(includeName);

    if (visited.has(includePath)) {
      result += `<!-- circular include skipped: ${includeName} -->\n`;
    } else {
      const inc = await readFileCached(includePath);
      if (inc === null) {
        result += `<!-- missing include: ${includeName} -->\n`;
      } else {
        const nested = await resolveIncludes(inc, new Set([...visited, includePath]));
        result += nested.trimEnd() + "\n";
      }
    }
    last = m.index + m[0].length;
  }
  result += text.slice(last);
  return result;
}

export async function readRole(path: string): Promise<string | null> {
  const raw = await readFileCached(path);
  if (raw === null) return null;
  return resolveIncludes(raw);
}
