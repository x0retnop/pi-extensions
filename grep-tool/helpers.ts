/**
 * Pure helpers for grep-tool — kept separate so unit tests can cover path
 * normalization and broad-query policy without loading the full extension.
 */

import path from "node:path";

export const DEFAULT_HEAD_LIMIT = 200;
export const BROAD_CONTENT_THRESHOLD = 100;
export const BROAD_CONTEXT_THRESHOLD = 50;
export const MAX_LINE_LENGTH = 500;

/** Directory-walk excludes. An explicit path overrides rg globs — also check isEnvFilePath. */
export const ENV_EXCLUDE_GLOBS = ["!.env", "!.env.*", "!**/.env", "!**/.env.*"] as const;

export function isEnvFilePath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return base === ".env" || base.startsWith(".env.");
}

export function pushEnvExcludeGlobs(args: string[]): void {
  for (const glob of ENV_EXCLUDE_GLOBS) {
    args.push("-g", glob);
  }
}

/** Resolve agent-supplied path; accepts Git Bash `/c/...` forms on Windows. */
export function toAbsoluteAgentPath(raw: string | undefined, cwd: string): string {
  if (!raw) return cwd;
  let trimmed = raw.replace(/^["']|["']$/g, "");
  // Convert Git Bash /c/... style paths to Windows drive letters so Node can resolve them.
  trimmed = trimmed.replace(/^\/([a-zA-Z])(?=\/)/, "$1:");
  return path.resolve(cwd, trimmed);
}

export function truncateLine(text: string, maxLen = MAX_LINE_LENGTH): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + " [...truncated]";
}

export function isRegexError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("regex parse error") ||
    lower.includes("error parsing regex") ||
    lower.includes("unrecognized escape") ||
    lower.includes("invalid regex") ||
    lower.includes("regex syntax error")
  );
}

/**
 * Whether content-mode preflight should run and potentially block a broad query.
 * Skipped when allow_broad is set, or when the caller's head_limit is already
 * at/below the broad threshold (output is naturally capped).
 */
export function shouldRunBroadPreflight(options: {
  mode: string;
  allowBroad?: boolean;
  headLimit?: number;
  hasContext: boolean;
}): boolean {
  if (options.mode !== "content") return false;
  if (options.allowBroad) return false;
  const threshold = options.hasContext ? BROAD_CONTEXT_THRESHOLD : BROAD_CONTENT_THRESHOLD;
  return options.headLimit === undefined || options.headLimit > threshold;
}

export function broadThreshold(hasContext: boolean): number {
  return hasContext ? BROAD_CONTEXT_THRESHOLD : BROAD_CONTENT_THRESHOLD;
}

/** Parse `rg -c` stdout into total match count and file count. */
export function parseRgCountStdout(stdout: string): { count: number; files: number } {
  let count = 0;
  let files = 0;
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    // Paths may contain ':' on some filesystems, so split at the last colon.
    const colonIdx = line.lastIndexOf(":");
    if (colonIdx > 0) {
      const countStr = line.slice(colonIdx + 1);
      if (/^\d+$/.test(countStr)) {
        count += parseInt(countStr, 10);
        files++;
      }
    }
  }
  return { count, files };
}
