import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const DEFAULT_HEAD_LIMIT = 200;
const BROAD_CONTENT_THRESHOLD = 100;
const BROAD_CONTEXT_THRESHOLD = 50;
const PREFLIGHT_TIMEOUT_MS = 15000;
const MAX_LINE_LENGTH = 500;

function findRg(): string | null {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore", windowsHide: true });
    return "rg";
  } catch {
    return null;
  }
}

interface GrepMatch {
  file: string;
  line_number: number;
  content: string;
  match?: string;
}

interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "content" | "files_with_matches" | "count_matches";
  multiline?: boolean;
  fixed_strings?: boolean;
  word_match?: boolean;
  "-i"?: boolean;
  "-n"?: boolean;
  "-C"?: number;
  "-B"?: number;
  "-A"?: number;
  head_limit?: number;
  include_ignored?: boolean;
  allow_broad?: boolean;
}

function toAbsoluteAgentPath(raw: string | undefined, cwd: string): string {
  if (!raw) return cwd;
  let trimmed = raw.replace(/^["']|["']$/g, "");
  // Convert Git Bash /c/... style paths to Windows drive letters so Node can resolve them.
  trimmed = trimmed.replace(/^\/([a-zA-Z])(?=\/)/, "$1:");
  return path.resolve(cwd, trimmed);
}

function truncateLine(text: string, maxLen = MAX_LINE_LENGTH): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + " [...truncated]";
}

function isRegexError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("regex parse error") ||
    lower.includes("error parsing regex") ||
    lower.includes("unrecognized escape") ||
    lower.includes("invalid regex") ||
    lower.includes("regex syntax error")
  );
}

async function runPreflightCount(
  rgPath: string,
  params: GrepParams,
  searchPath: string,
  cwd: string,
): Promise<{ count: number; files: number; error?: string }> {
  const args: string[] = ["--color", "never", "-c"];
  if (params.fixed_strings) args.push("-F");
  if (params.word_match) args.push("-w");
  if (params.multiline) args.push("--multiline");
  if (params["-i"]) args.push("-i");
  if (params.glob) args.push("-g", params.glob);
  if (params.type) args.push("-t", params.type);
  if (params.include_ignored) {
    args.push("-uu");
    args.push("-g", "!.env");
    args.push("-g", "!**/.env");
  }
  args.push("-g", "!*.map");
  args.push("--");
  args.push(params.pattern);
  if (searchPath) args.push(searchPath);

  try {
    const { stdout } = await execFileAsync(rgPath, args, {
      cwd,
      maxBuffer: 2 * 1024 * 1024,
      timeout: PREFLIGHT_TIMEOUT_MS,
      windowsHide: true,
    });
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
  } catch (err: any) {
    const exitCode = err.status ?? err.code;
    if ((exitCode === 1 || exitCode === "1") && !err.stderr) {
      return { count: 0, files: 0 };
    }
    const stderr = err.stderr || "";
    if (isRegexError(stderr) && !params.fixed_strings) {
      return {
        count: 0,
        files: 0,
        error:
          `Regex parse error: ${stderr}\n\n` +
          `Hint: If you are searching for literal text/code, retry with "fixed_strings: true".`,
      };
    }
    if (err.code === "ETIMEDOUT" || err.killed) {
      return {
        count: 0,
        files: 0,
        error:
          "Preflight count timed out. The pattern may be too broad for this codebase. " +
          "Try output_mode: 'files_with_matches' or 'count_matches', or add filters.",
      };
    }
    return { count: 0, files: 0, error: `Preflight count error: ${stderr || err.message}` };
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "grep",
    label: "Grep",
    description:
      "Fast structured search via ripgrep. Respects .gitignore, supports glob/type filters, " +
      "context lines, case-insensitive search, and multiple output modes.\n\n" +
      "CRITICAL: `pattern` is a REGEX by default. " +
      "If searching for literal code/text that contains regex metacharacters — `().[]{}*+?^$\\|` — " +
      "set `fixed_strings: true` to avoid parse errors and unexpected matches.\n\n" +
      "Whitespace: source files may use tabs instead of spaces. " +
      "If an indented search returns nothing, try `fixed_strings: true` with the exact text copied from the file, " +
      "or use a regex like `^\\s+foo` instead of literal spaces/tabs.\n\n" +
      "Use `word_match: true` to match whole words only (e.g. `name` will not match `namespace`).\n\n" +
      "Examples:\n" +
      "- Find all TODOs: { pattern: 'TODO', output_mode: 'files_with_matches' }\n" +
      "- Exact code snippet: { pattern: 'function foo(', fixed_strings: true }\n" +
      "- Regex + file type: { pattern: 'class\\s+User', type: 'ts' }\n" +
      "- Whole word case-insensitive: { pattern: 'getUser', word_match: true, '-i': true }\n\n" +
      "Broad-query guidance:\n" +
      "- Before searching a large codebase, start with output_mode: 'files_with_matches' or 'count_matches' to orient yourself.\n" +
      "- Avoid short, unfiltered content searches (e.g. { pattern: 'function' }) — they produce walls of text.\n" +
      "- If a content query matches more than ~100 lines, the tool will refuse and suggest a narrower approach. Set allow_broad: true to override.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Regular expression to search for (treated as regex by default). " +
            "If the value contains regex metacharacters such as . ( ) [ ] { } * + ? ^ $ \\ | and you want an exact literal match, " +
            "set `fixed_strings: true`.",
        },
        path: {
          type: "string",
          description:
            "File or directory to search in. Accepts relative paths, absolute paths, " +
            "and Git Bash /c/... style paths. Defaults to the current working directory.",
        },
        glob: {
          type: "string",
          description: "Glob filter for file names, e.g. *.py or *.{ts,tsx}",
        },
        type: {
          type: "string",
          description: "File type filter: py, js, ts, rust, go, md, json, etc. (rg type shortcodes)",
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count_matches"],
          description:
            "content = matched lines with context (default), " +
            "files_with_matches = only file paths, " +
            "count_matches = total number of matches",
        },
        multiline: {
          type: "boolean",
          description: "Enable multiline matching (rg --multiline). Default false.",
        },
        fixed_strings: {
          type: "boolean",
          description:
            "Treat pattern as a literal string, not a regex (rg -F). " +
            "Use this when searching for exact code snippets or text that contains regex special characters.",
        },
        word_match: {
          type: "boolean",
          description:
            "Match only whole words (rg -w). Useful to avoid false positives, e.g. searching for 'name' won't match 'namespace'.",
        },
        "-i": {
          type: "boolean",
          description: "Case-insensitive search",
        },
        "-n": {
          type: "boolean",
          default: true,
          description: "Show line numbers (default true)",
        },
        "-C": {
          type: "integer",
          description: "Context lines around each match",
        },
        "-B": {
          type: "integer",
          description: "Context lines before each match",
        },
        "-A": {
          type: "integer",
          description: "Context lines after each match",
        },
        head_limit: {
          type: "integer",
          description: "Limit total results to first N matches. If omitted, defaults to 200 to avoid flooding the context window.",
        },
        include_ignored: {
          type: "boolean",
          description: "Search in files ignored by .gitignore. Still excludes .env for safety.",
        },
        allow_broad: {
          type: "boolean",
          description: "Skip the broad-query guard. Only set this if you intentionally want a large content dump.",
        },
      },
      required: ["pattern"],
    },
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      const cwd = process.cwd();
      const rgPath = findRg();
      if (!rgPath) {
        return {
          content: [{ type: "text", text: "ripgrep (rg) not found in PATH" }],
          details: { error: "rg not found" },
        };
      }

      const searchPath = toAbsoluteAgentPath(params.path, cwd);

      const mode = params.output_mode || "content";
      const userLimit = params.head_limit;
      const hasContext =
        params["-C"] !== undefined || params["-B"] !== undefined || params["-A"] !== undefined;
      const broadThreshold = hasContext ? BROAD_CONTEXT_THRESHOLD : BROAD_CONTENT_THRESHOLD;

      // Only guard content queries that are not explicitly capped below the broad threshold.
      if (
        mode === "content" &&
        !params.allow_broad &&
        (userLimit === undefined || userLimit > broadThreshold)
      ) {
        const preflight = await runPreflightCount(rgPath, params, searchPath, cwd);
        if (preflight.error) {
          return {
            content: [{ type: "text", text: preflight.error }],
            details: { error: preflight.error },
          };
        }
        if (preflight.count > broadThreshold) {
          const guardText =
            `Pattern is too broad: found ${preflight.count} matching lines across ${preflight.files} files. ` +
            `Returning full content would create a wall of text and waste context.\n\n` +
            `Try one of these first:\n` +
            `- output_mode: "files_with_matches" to see which files match.\n` +
            `- output_mode: "count_matches" to measure the scope.\n` +
            `- Add a filter: glob (e.g. "*.ts"), type (e.g. "ts"), word_match: true, or a narrower path.\n` +
            `- If you really need the dump, rerun with allow_broad: true.`;
          return {
            content: [{ type: "text", text: guardText }],
            details: { broad: true, count: preflight.count, files: preflight.files },
          };
        }
      }

      const args: string[] = ["--json", "--color", "never"];

      if (params.fixed_strings) args.push("-F");
      if (params.word_match) args.push("-w");
      if (params.multiline) args.push("--multiline");
      if (params["-i"]) args.push("-i");
      if (params["-n"] !== false) args.push("--line-number");

      if (params["-C"] !== undefined) {
        args.push("-C", String(params["-C"]));
      } else {
        if (params["-B"] !== undefined) args.push("-B", String(params["-B"]));
        if (params["-A"] !== undefined) args.push("-A", String(params["-A"]));
      }

      if (params.glob) args.push("-g", params.glob);
      if (params.type) args.push("-t", params.type);

      if (params.include_ignored) {
        args.push("-uu");
        args.push("-g", "!.env");
        args.push("-g", "!**/.env");
      }

      args.push("-g", "!*.map");
      args.push("--");
      args.push(params.pattern);

      if (searchPath) {
        args.push(searchPath);
      }

      try {
        const { stdout } = await execFileAsync(rgPath, args, {
          cwd,
          maxBuffer: 2 * 1024 * 1024,
          timeout: 30000,
          windowsHide: true,
        });

        const lines = stdout.trim().split("\n").filter(Boolean);
        const matches: GrepMatch[] = [];
        const files = new Set<string>();
        let totalMatches = 0;

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "match") {
              totalMatches++;
              const file =
                typeof obj.data.path === "string"
                  ? obj.data.path
                  : obj.data.path?.text || "";
              if (file) files.add(file);

              const lineNum = obj.data.line_number;
              const content = truncateLine((obj.data.lines?.text || "").replace(/\n$/, ""));
              const submatch = truncateLine(obj.data.submatches?.[0]?.match?.text || "");

              matches.push({
                file,
                line_number: lineNum,
                content,
                match: submatch,
              });
            } else if (obj.type === "summary") {
              totalMatches = obj.data.stats?.matches ?? totalMatches;
            }
          } catch {
            // skip malformed JSON line
          }
        }

        const effectiveLimit = userLimit ?? DEFAULT_HEAD_LIMIT;

        function makeHint(count: number): string {
          if (count <= effectiveLimit) return "";
          return (
            `\n\n[Hint: Showing ${effectiveLimit} of ${count} matches. ` +
            `The pattern may be too broad. Consider: a more specific regex, ` +
            `a glob filter (e.g. "*.ts"), a narrower path, word_match: true, ` +
            `or first use output_mode: "count_matches" / "files_with_matches".]`
          );
        }

        if (mode === "files_with_matches") {
          const fileList = Array.from(files);
          const limited = fileList.slice(0, effectiveLimit);
          const text = limited.join("\n") || "(no matches)";
          return {
            content: [{ type: "text", text: text + makeHint(files.size) }],
            details: {
              files: limited,
              count: limited.length,
              total: files.size,
              truncated: files.size > effectiveLimit,
            },
          };
        }

        if (mode === "count_matches") {
          return {
            content: [{ type: "text", text: String(totalMatches) }],
            details: { count: totalMatches },
          };
        }

        const limitedMatches = matches.slice(0, effectiveLimit);
        const text = limitedMatches.length
          ? limitedMatches
              .map((m) => `${m.file}:${m.line_number}: ${m.content}`)
              .join("\n")
          : "(no matches)";

        return {
          content: [{ type: "text", text: text + makeHint(matches.length) }],
          details: {
            matches: limitedMatches,
            count: limitedMatches.length,
            total: matches.length,
            truncated: matches.length > effectiveLimit,
          },
        };
      } catch (err: any) {
        if (err.code === "ENOENT") {
          return {
            content: [{ type: "text", text: "ripgrep (rg) not found in PATH" }],
            details: { error: "rg not found" },
          };
        }
        // On Windows execFile puts the exit code in err.code (number) instead of err.status.
        const exitCode = err.status ?? err.code;
        if ((exitCode === 1 || exitCode === "1") && !err.stderr) {
          return {
            content: [{ type: "text", text: "(no matches)" }],
            details: { count: 0 },
          };
        }

        const stderr = err.stderr || "";
        if (isRegexError(stderr) && !params.fixed_strings) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Grep regex error: ${stderr}\n\n` +
                  `Hint: Your pattern contains characters that are invalid or special in regex. ` +
                  `If you are searching for literal text/code, retry with "fixed_strings: true".`,
              },
            ],
            details: { error: stderr, hint: "try fixed_strings: true" },
          };
        }

        return {
          content: [
            { type: "text", text: `Grep error: ${stderr || err.message}` },
          ],
          details: { error: stderr || err.message },
        };
      }
    },
  });
}
