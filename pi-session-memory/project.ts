import fs from "node:fs";
import path from "node:path";

/**
 * Extract a human-readable project name from a Pi session file path.
 *
 * Pi stores sessions under `~/.pi/agent/sessions/--C--<segments>--/`.
 * Path separators become single `-`, so reverse decoding is lossy when
 * directory names themselves contain hyphens. Prefer
 * {@link extractProjectFromSessionFile} when the `.jsonl` is readable.
 */
export function extractProject(sourcePath: string): string {
  const parts = sourcePath.split(/[\\/]/);
  for (const part of parts) {
    if (part.startsWith("--") && part.endsWith("--")) {
      const inner = part.slice(2, -2);
      if (inner.includes("--")) {
        const segments = inner.split("--");
        if (segments.length > 0 && /^[A-Za-z]$/.test(segments[0])) {
          segments[0] = segments[0] + ":";
        }
        return segments.join("/");
      }
      // Single-dash encoding: `--C--10x001-pi extensions--` → best-effort label.
      // Drive letter is still recoverable; remaining path stays hyphen-joined.
      const m = inner.match(/^([A-Za-z])--(.+)$/);
      if (m) return `${m[1]}:/${m[2]}`;
    }
  }
  return path.basename(path.dirname(sourcePath));
}

/**
 * Prefer the session header `cwd` (type:"session") for a faithful project path.
 * Falls back to {@link extractProject} when the file is unreadable or has no header.
 */
export function extractProjectFromSessionFile(sourcePath: string): string {
  const cwd = readSessionCwd(sourcePath);
  if (cwd) return normalizeProjectPath(cwd);
  return extractProject(sourcePath);
}

/** Read `cwd` from the session header line (usually the first JSONL record). */
export function readSessionCwd(sourcePath: string): string | undefined {
  try {
    const fd = fs.openSync(sourcePath, "r");
    try {
      const buffer = Buffer.alloc(8 * 1024);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const head = buffer.toString("utf-8", 0, bytesRead);
      let rest = head;
      let idx: number;
      let lines = 0;
      while (lines < 20 && (idx = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, idx).trim();
        rest = rest.slice(idx + 1);
        lines++;
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === "object" && obj.type === "session" && typeof obj.cwd === "string" && obj.cwd.trim()) {
            return obj.cwd.trim();
          }
        } catch {
          // skip non-json
        }
      }
      // last partial line without trailing newline
      const tail = rest.trim();
      if (tail) {
        try {
          const obj = JSON.parse(tail);
          if (obj && typeof obj === "object" && obj.type === "session" && typeof obj.cwd === "string" && obj.cwd.trim()) {
            return obj.cwd.trim();
          }
        } catch {
          // ignore
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // unreadable
  }
  return undefined;
}

/** Normalize Windows/POSIX cwd to a stable forward-slash display path. */
export function normalizeProjectPath(cwd: string): string {
  let p = cwd.replace(/\\/g, "/");
  // Strip trailing slashes except drive root `C:/`
  if (p.length > 3) p = p.replace(/\/+$/, "");
  return p;
}

/**
 * True when the session file's project differs from the current cwd's project.
 * Used to warn before switching sessions: switchSession replaces the active
 * session and jumps cwd to the target session's project.
 */
export function isDifferentProject(sourcePath: string, currentCwd: string): boolean {
  if (!sourcePath || !currentCwd) return false;
  const target = extractProjectFromSessionFile(sourcePath) || extractProject(sourcePath);
  if (!target) return false;
  return normalizeProjectPath(target) !== normalizeProjectPath(currentCwd);
}
