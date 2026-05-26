import path from "node:path";
import { homedir } from "node:os";

export type PathScope = "inside_project" | "outside_project" | "protected";

export interface PathAccess {
  scope: PathScope;
  reason: string;
}

function getHome(): string {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

function getDefaultProtectedRoots(): string[] {
  const home = getHome();
  return [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
    path.join(home, ".ssh"),
    path.join(home, ".config"),
    "C:\\",
  ].map((r) => path.resolve(r).toLowerCase());
}

function expandHome(input: string): string {
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(getHome(), input.slice(2));
  }
  if (input === "~") {
    return getHome();
  }
  return input;
}

export function normalizePath(input: string, cwd: string): string {
  if (!input) return "";
  const cleaned = expandHome(input.replace(/^["']|["']$/g, ""));
  return path.resolve(path.isAbsolute(cleaned) ? cleaned : path.join(cwd, cleaned));
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

export function classifyPathAccess(
  targetPath: string,
  cwd: string,
  workspaceRoots: string[],
  extraProtectedRoots: string[]
): PathAccess {
  const normalized = normalizePath(targetPath, cwd).toLowerCase();
  const normalizedCwd = path.resolve(cwd).toLowerCase();

  if (isInside(normalized, normalizedCwd)) {
    return { scope: "inside_project", reason: "inside current project" };
  }

  for (const root of workspaceRoots) {
    if (isInside(normalized, root)) {
      return { scope: "inside_project", reason: "inside workspace" };
    }
  }

  const allProtected = [
    ...getDefaultProtectedRoots(),
    ...extraProtectedRoots.map((r) => path.resolve(r).toLowerCase()),
  ];

  for (const root of allProtected) {
    const isDriveRoot = path.parse(root).root.toLowerCase() === root.toLowerCase();
    const protectedMatch = isDriveRoot ? normalized === root : isInside(normalized, root);
    if (protectedMatch) {
      return { scope: "protected", reason: `protected root: ${root}` };
    }
  }

  return { scope: "outside_project", reason: "outside current project" };
}

export function extractFilePath(input: any): string | null {
  const candidates = [
    input?.path,
    input?.file,
    input?.filePath,
    input?.filepath,
    input?.filename,
    input?.target,
    input?.targetPath,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function cwdIsTooBroad(cwd: string): boolean {
  const home = getHome();
  const normalizedCwd = path.resolve(cwd).toLowerCase();

  const broadRoots = [
    "C:\\",
    home,
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Downloads"),
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p).toLowerCase());

  return broadRoots.includes(normalizedCwd);
}

export function looksLikePath(s: string): boolean {
  if (!s) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (s === "~") return true;
  if (/^~[\\/]/.test(s)) return true;
  if (/^[\\/]/.test(s)) return true;
  if (/^\.{1,2}[\\/]/.test(s)) return true;
  if (!s.startsWith("-") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /[\\/]/.test(s)) return true;
  return false;
}
