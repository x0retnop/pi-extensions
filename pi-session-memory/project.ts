import path from "node:path";

/**
 * Extract a human-readable project name from a Pi session file path.
 *
 * Pi stores sessions under `~/.pi/agent/sessions/--C--<drive>--<path>--/`.
 * This function converts that encoded directory name back to `C:/path` form.
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
    }
  }
  return path.basename(path.dirname(sourcePath));
}
