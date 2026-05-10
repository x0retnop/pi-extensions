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

export function normalizePath(input: string, cwd: string): string {
  if (!input) return "";
  const cleaned = input.replace(/^["']|["']$/g, "");
  return path.resolve(path.isAbsolute(cleaned) ? cleaned : path.join(cwd, cleaned));
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
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

function getTrustedReadRoots(): string[] {
  const home = getHome();

  return [
    path.join(home, "AppData", "Roaming", "npm", "node_modules"),
    path.join(home, "AppData", "Local", "Programs"),
    path.join(home, ".cargo", "registry"),
    path.join(home, "go", "pkg", "mod"),
    path.join(home, ".nuget", "packages"),
    path.join(home, ".gradle", "caches", "modules-2"),
    path.join(home, ".m2", "repository"),
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p).toLowerCase());
}

function getProtectedRoots(): string[] {
  const home = getHome();

  return [
    "C:\\",
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
    path.join(home, ".ssh"),
    path.join(home, ".pi"),
    path.join(home, ".config"),
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p).toLowerCase());
}

export function classifyPathAccess(targetPath: string, cwd: string): PathAccess {
  const normalized = normalizePath(targetPath, cwd).toLowerCase();
  const normalizedCwd = path.resolve(cwd).toLowerCase();

  if (isInside(normalized, normalizedCwd)) {
    return { scope: "inside_project", reason: "inside current project" };
  }

  for (const root of getProtectedRoots()) {
    const isDriveRoot = path.resolve(root).toLowerCase() === path.parse(root).root.toLowerCase();
    const protectedMatch = isDriveRoot ? normalized === root : isInside(normalized, root);
    if (protectedMatch) {
      return { scope: "protected", reason: `protected root: ${root}` };
    }
  }

  for (const root of getTrustedReadRoots()) {
    if (isInside(normalized, root)) {
      return { scope: "outside_project", reason: `trusted read root: ${root}` };
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

// Bash path heuristics
export function commandHasTraversal(command: string): boolean {
  return command.includes("..\\") || command.includes("../");
}

export function commandMentionsExternalOrProtectedPath(command: string): boolean {
  const lower = command.toLowerCase();
  const hints = [
    "c:\\", "c:/",
    "\\windows", "/windows",
    "program files", "programdata",
    "\\users\\", "/users/",
    ".ssh", ".pi", ".config",
    "desktop", "documents", "downloads",
  ];
  return hints.some((hint) => lower.includes(hint.toLowerCase()));
}
