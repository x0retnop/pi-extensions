import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolUpdateCallback,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  DEFAULT_HEAD_LIMIT,
  broadThreshold,
  isEnvFilePath,
  isRegexError,
  parseRgCountStdout,
  pushEnvExcludeGlobs,
  shouldRunBroadPreflight,
  toAbsoluteAgentPath,
  truncateLine,
} from "./helpers.js";

const execFileAsync = promisify(execFile);

const PREFLIGHT_TIMEOUT_MS = 15000;

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
  isContext?: boolean;
}

type OutputMode = "content" | "files_with_matches" | "count_matches";

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

interface GrepToolDetails {
  matches?: GrepMatch[];
  count?: number;
  total?: number;
  files?: string[];
  per_file?: Record<string, number>;
  truncated?: boolean;
  broad?: boolean;
  error?: string;
}

function formatGrepCall(params: GrepParams, theme: Theme): string {
  let header = theme.fg("toolTitle", theme.bold("grep"));
  // The row renders before `pattern` has streamed in; `...` is the placeholder the other rows use
  // (write/pwsh), never the string "undefined".
  header += " " + (typeof params.pattern === "string" && params.pattern
    ? theme.fg("accent", params.pattern)
    : theme.fg("muted", "..."));

  const parts: string[] = [];
  if (params.path) parts.push(`path=${params.path}`);
  if (params.glob) parts.push(`glob=${params.glob}`);
  if (params.type) parts.push(`type=${params.type}`);
  if (params.output_mode && params.output_mode !== "content") {
    parts.push(`mode=${params.output_mode}`);
  }
  if (params.head_limit !== undefined) parts.push(`limit=${params.head_limit}`);
  if (params.fixed_strings) parts.push("-F");
  if (params.word_match) parts.push("-w");
  if (params["-i"]) parts.push("-i");
  if (params["-C"] !== undefined) parts.push(`-C ${params["-C"]}`);
  if (params["-B"] !== undefined) parts.push(`-B ${params["-B"]}`);
  if (params["-A"] !== undefined) parts.push(`-A ${params["-A"]}`);

  if (parts.length > 0) {
    header += " " + theme.fg("muted", `(${parts.join(", ")})`);
  }
  return header;
}

async function runPreflightCount(
  rgPath: string,
  params: GrepParams,
  searchPath: string,
  cwd: string,
): Promise<{ count: number; files: number; error?: string }> {
  // --with-filename: bare `rg -c` on one file prints only the count, which
  // parseRgCountStdout drops, so the broad guard would never fire.
  const args: string[] = ["--color", "never", "--with-filename", "-c"];
  if (params.fixed_strings) args.push("-F");
  if (params.word_match) args.push("-w");
  if (params.multiline) args.push("--multiline");
  if (params["-i"]) args.push("-i");
  if (params.glob) args.push("-g", params.glob);
  if (params.type) args.push("-t", params.type);
  if (params.include_ignored) args.push("-uu");
  pushEnvExcludeGlobs(args);
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
    return parseRgCountStdout(stdout);
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
      "Ripgrep. pattern is a regex; fixed_strings for literal text. " +
      "A tab/space miss: fixed_strings with the exact line, or `^\\s+`. " +
      "Content mode refuses above ~100 matches unless head_limit is at or below that, or allow_broad. " +
      "multiline does not make `.` match a newline — put `\\n` in the pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex, unless fixed_strings.",
        },
        path: {
          type: "string",
          description: "File or directory. Default: session cwd.",
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
          description: "content (default), files_with_matches, or count_matches (total plus top files).",
        },
        multiline: {
          type: "boolean",
          description: "Multiline anchors. Dot still does not match newline.",
        },
        fixed_strings: {
          type: "boolean",
          description: "Literal match, not regex.",
        },
        word_match: {
          type: "boolean",
          description: "Whole word only.",
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
          description: "Max matches. Default 200.",
        },
        include_ignored: {
          type: "boolean",
          description: "Also search gitignored files. Skips .env and .env.*.",
        },
        allow_broad: {
          type: "boolean",
          description: "Skip the broad-query refuse.",
        },
      },
      required: ["pattern"],
    },

    renderCall(args: any, theme: Theme, context: { lastComponent?: unknown }) {
      const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      component.setText(formatGrepCall(args as GrepParams, theme));
      return component;
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
          isError: true,
        };
      }

      const searchPath = toAbsoluteAgentPath(params.path, cwd);
      if (params.path && isEnvFilePath(searchPath)) {
        return {
          content: [{ type: "text", text: "Refused: grep does not search .env files." }],
          details: { error: "env excluded" },
          isError: true,
        };
      }

      const mode = params.output_mode || "content";
      const userLimit = params.head_limit;
      const hasContext =
        params["-C"] !== undefined || params["-B"] !== undefined || params["-A"] !== undefined;
      const broadLimit = broadThreshold(hasContext);

      // Only guard content queries that are not explicitly capped below the broad threshold.
      if (
        shouldRunBroadPreflight({
          mode,
          allowBroad: params.allow_broad,
          headLimit: userLimit,
          hasContext,
        })
      ) {
        const preflight = await runPreflightCount(rgPath, params, searchPath, cwd);
        if (preflight.error) {
          return {
            content: [{ type: "text", text: preflight.error }],
            details: { error: preflight.error },
            isError: true,
          };
        }
        if (preflight.count > broadLimit) {
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
            isError: true,
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

      if (params.include_ignored) args.push("-uu");
      pushEnvExcludeGlobs(args);

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
        const contextQueue: GrepMatch[] = [];
        const files = new Set<string>();
        let totalMatches = 0;
        let contextAfterRemaining = 0;

        const flushContext = () => {
          if (contextQueue.length > 0) {
            matches.push(...contextQueue);
            contextQueue.length = 0;
          }
        };

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            const file =
              typeof obj.data?.path === "string"
                ? obj.data.path
                : obj.data?.path?.text || "";
            if (file) files.add(file);

            if (obj.type === "match") {
              totalMatches++;
              flushContext();
              contextAfterRemaining = params["-A"] ?? params["-C"] ?? 0;

              const lineNum = obj.data.line_number;
              const content = truncateLine((obj.data.lines?.text || "").replace(/\n$/, ""));
              const submatch = truncateLine(obj.data.submatches?.[0]?.match?.text || "");

              matches.push({
                file,
                line_number: lineNum,
                content,
                match: submatch,
              });
            } else if (obj.type === "context") {
              // Context lines belong to the most recent match. Preceding context
              // is emitted by rg before the match; trailing context is emitted after.
              const lineNum = obj.data.line_number;
              const content = truncateLine((obj.data.lines?.text || "").replace(/\n$/, ""));
              contextQueue.push({
                file,
                line_number: lineNum,
                content,
                isContext: true,
              });
            } else if (obj.type === "summary") {
              totalMatches = obj.data.stats?.matches ?? totalMatches;
            }
          } catch {
            // skip malformed JSON line
          }

          if (contextAfterRemaining > 0 && contextQueue.length > 0) {
            // The first queued context line after a match is trailing context.
            // Once trailing context has been flushed, any remaining queued lines
            // belong to the next match.
            flushContext();
            contextAfterRemaining--;
          }
        }
        flushContext();

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
              // The built-in grep body prints its collapsed `[Truncated: … limit]` line from this
              // field; without it a capped list is silent in the row (the extension's own hint sits
              // at the end of the text, below the 15-line preview).
              ...(files.size > effectiveLimit ? { matchLimitReached: effectiveLimit } : {}),
            },
          };
        }

        if (mode === "count_matches") {
          // Per-file breakdown by matching lines, so scoping questions
          // ("which files have the most hits?") don't require bash `rg -c`.
          const perFile = new Map<string, number>();
          for (const m of matches) {
            const f = m.file || "(unknown)";
            perFile.set(f, (perFile.get(f) ?? 0) + 1);
          }
          const sorted = Array.from(perFile.entries()).sort((a, b) => b[1] - a[1]);
          const fileCap = userLimit ?? 20;
          const shown = sorted.slice(0, fileCap);
          let text = `${totalMatches} matches in ${perFile.size} files`;
          if (shown.length > 0) {
            text += ":\n" + shown.map(([f, c]) => `${f}: ${c}`).join("\n");
            if (sorted.length > shown.length) {
              text += `\n[...and ${sorted.length - shown.length} more files]`;
            }
          }
          return {
            content: [{ type: "text", text }],
            details: {
              count: totalMatches,
              files: perFile.size,
              per_file: Object.fromEntries(shown),
            },
          };
        }

        const limitedMatches = matches.slice(0, effectiveLimit);
        const text = limitedMatches.length
          ? limitedMatches
              .map((m) => {
                const prefix = m.isContext ? "  " : "";
                return `${prefix}${m.file}:${m.line_number}: ${m.content}`;
              })
              .join("\n")
          : "(no matches)";

        return {
          content: [{ type: "text", text: text + makeHint(matches.length) }],
          details: {
            matches: limitedMatches,
            count: limitedMatches.length,
            total: matches.length,
            truncated: matches.length > effectiveLimit,
            ...(matches.length > effectiveLimit ? { matchLimitReached: effectiveLimit } : {}),
          },
        };
      } catch (err: any) {
        if (err.code === "ENOENT") {
          return {
            content: [{ type: "text", text: "ripgrep (rg) not found in PATH" }],
            details: { error: "rg not found" },
            isError: true,
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
            isError: true,
          };
        }

        return {
          content: [
            { type: "text", text: `Grep error: ${stderr || err.message}` },
          ],
          details: { error: stderr || err.message },
          isError: true,
        };
      }
    },
  });
}
