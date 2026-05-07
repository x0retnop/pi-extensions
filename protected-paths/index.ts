// @ts-nocheck

import path from "node:path";

function normalizePath(input: string, cwd: string): string {
  if (!input) return "";
  const cleaned = input.replace(/^["']|["']$/g, "");
  return path.resolve(path.isAbsolute(cleaned) ? cleaned : path.join(cwd, cleaned));
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function getHome(): string {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function extractFilePath(input: any): string | null {
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

function cwdIsTooBroad(cwd: string): boolean {
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

function classifyPathAccess(targetPath: string, cwd: string): {
  scope: "inside_project" | "outside_project" | "protected";
  reason: string;
} {
  const normalized = normalizePath(targetPath, cwd).toLowerCase();
  const normalizedCwd = path.resolve(cwd).toLowerCase();

  if (isInside(normalized, normalizedCwd)) {
    return {
      scope: "inside_project",
      reason: "inside current project",
    };
  }

  for (const root of getProtectedRoots()) {
    if (isInside(normalized, root)) {
      return {
        scope: "protected",
        reason: `protected root: ${root}`,
      };
    }
  }

  return {
    scope: "outside_project",
    reason: "outside current project",
  };
}

function commandHasTraversal(command: string): boolean {
  return command.includes("..\\") || command.includes("../");
}

function commandMentionsExternalOrProtectedPath(command: string): boolean {
  const lower = command.toLowerCase();

  const hints = [
    "c:\\",
    "c:/",
    "\\windows",
    "/windows",
    "program files",
    "programdata",
    "\\users\\",
    "/users/",
    ".ssh",
    ".pi",
    ".config",
    "desktop",
    "documents",
    "downloads",
  ];

  return hints.some((hint) => lower.includes(hint.toLowerCase()));
}

function commandIsHardDestructive(command: string): boolean {
  const hardDestructivePatterns = [
    /^\s*rm\s+-rf\s+[\/\\]\s*$/i,
    /^\s*rm\s+-rf\s+["']?[A-Z]:[\\\/]?["']?\s*$/i,
    /^\s*del\s+\/[fsq]+\s+[A-Z]:[\\\/]?/i,
    /^\s*rmdir\s+\/s\s+\/q\s+[A-Z]:[\\\/]?/i,
    /^\s*format\b/i,
    /^\s*diskpart\b/i,
    /^\s*bcdedit\b/i,
    /^\s*shutdown\b/i,
    /^\s*restart-computer\b/i,
    /^\s*stop-computer\b/i,
    /^\s*git\s+clean\b/i,
    /^\s*git\s+reset\s+--hard\b/i,
    /\bRemove-Item\b.*\s-Recurse\b/i,
    /\bRemove-Item\b.*\s-Force\b/i,
    /\bInvoke-Expression\b/i,
    /\biex\b/i,
    /\bsudo\b/i,
    /\bchmod\b.*777\b/i,
    /\bchown\b/i,
  ];

  return hardDestructivePatterns.some((p) => p.test(command));
}

function commandIsExternalWriteLike(command: string): boolean {
  const writeLikePatterns = [
    /^\s*cp\b/i,
    /^\s*copy\b/i,
    /^\s*xcopy\b/i,
    /^\s*robocopy\b/i,
    /^\s*mv\b/i,
    /^\s*move\b/i,
    /^\s*New-Item\b/i,
    /^\s*Set-Content\b/i,
    /^\s*Add-Content\b/i,
    /^\s*Out-File\b/i,
    /^\s*cmd\s+\/c\b/i,
    /^\s*powershell\b/i,
    /^\s*pwsh\b/i,
    />{1,2}/,
  ];

  return writeLikePatterns.some((p) => p.test(command));
}

async function askOnce(ctx: any, message: string): Promise<boolean> {
  if (!ctx?.hasUI) return false;

  const choice = await ctx.ui.select(message, ["Yes", "No"]);
  return choice === "Yes";
}

async function askTwice(ctx: any, message: string): Promise<boolean> {
  if (!ctx?.hasUI) return false;

  const first = await ctx.ui.select(
    `${message}\n\nFirst confirmation: allow?`,
    ["Yes", "No"]
  );

  if (first !== "Yes") return false;

  const second = await ctx.ui.select(
    `${message}\n\nSecond confirmation: are you sure?`,
    ["Yes, I am sure", "No"]
  );

  return second === "Yes, I am sure";
}

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    const cwd = String(ctx?.cwd || process.cwd());
    const tool = String(event.toolName ?? "");
    const input = event.input ?? {};

    if (cwdIsTooBroad(cwd)) {
      return {
        block: true,
        reason:
          `Blocked: PI is running from a too-broad directory.\n` +
          `Current directory: ${cwd}\n` +
          `Start PI inside a specific project folder instead.`,
      };
    }

    // read outside project: ask once.
    if (tool === "read") {
      const filePath = extractFilePath(input);
      if (!filePath) return undefined;

      const access = classifyPathAccess(filePath, cwd);

      if (access.scope === "inside_project") {
        return undefined;
      }

      const allowed = await askOnce(
        ctx,
        `Read file outside current project?\n\nPath: ${filePath}\nReason: ${access.reason}`
      );

      if (!allowed) {
        return {
          block: true,
          reason: `Blocked read outside current project: ${filePath}`,
        };
      }

      return undefined;
    }

    // write/edit outside project: double ask.
    if (tool === "write" || tool === "edit") {
      const filePath = extractFilePath(input);
      if (!filePath) return undefined;

      const access = classifyPathAccess(filePath, cwd);

      if (access.scope === "inside_project") {
        return undefined;
      }

      const allowed = await askTwice(
        ctx,
        `${tool.toUpperCase()} file outside current project?\n\n` +
        `Path: ${filePath}\n` +
        `Reason: ${access.reason}\n\n` +
        `This may modify files outside the active project.`
      );

      if (!allowed) {
        return {
          block: true,
          reason: `Blocked ${tool} outside current project: ${filePath}`,
        };
      }

      return undefined;
    }

    if (tool === "bash") {
      const command = String(input.command ?? "").trim();

      if (!command) return undefined;

      if (commandIsHardDestructive(command)) {
        return {
          block: true,
          reason: `Blocked destructive bash command:\n${command}`,
        };
      }

      if (commandHasTraversal(command) && commandIsExternalWriteLike(command)) {
        return {
          block: true,
          reason: `Blocked bash command with path traversal:\n${command}`,
        };
      }

      if (
        commandMentionsExternalOrProtectedPath(command) &&
        commandIsExternalWriteLike(command)
      ) {
        const allowed = await askTwice(
          ctx,
          `Bash command may write outside current project.\n\n` +
          `Command:\n${command}\n\n` +
          `Only allow this if you intentionally want to modify an external file.`
        );

        if (!allowed) {
          return {
            block: true,
            reason: `Blocked external write-like bash command:\n${command}`,
          };
        }

        return undefined;
      }
    }

    return undefined;
  });
}
