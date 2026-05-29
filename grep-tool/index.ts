import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const DEFAULT_HEAD_LIMIT = 200;

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
}

function resolvePath(raw: string | undefined): string {
  if (!raw) return ".";
  const trimmed = raw.replace(/^["']|["']$/g, "");
  return trimmed;
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
      "- Whole word case-insensitive: { pattern: 'getUser', word_match: true, '-i': true }",
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
          description: "File or directory to search in. Defaults to current working directory.",
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

      args.push("--");
      args.push(params.pattern);

      const searchPath = resolvePath(params.path);
      if (searchPath) {
        args.push(searchPath);
      }

      const rgPath = findRg();
      if (!rgPath) {
        return {
          content: [{ type: "text", text: "ripgrep (rg) not found in PATH" }],
          details: { error: "rg not found" },
        };
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
              const content = (obj.data.lines?.text || "").replace(/\n$/, "");
              const submatch = obj.data.submatches?.[0]?.match?.text || "";

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

        const userLimit = params.head_limit;
        const effectiveLimit = userLimit ?? DEFAULT_HEAD_LIMIT;
        const mode = params.output_mode || "content";

        function makeHint(count: number): string {
          if (userLimit !== undefined || count <= effectiveLimit) return "";
          return (
            `\n\n[Hint: Results limited to ${DEFAULT_HEAD_LIMIT} matches. ` +
            `The pattern may be too broad. Consider: a more specific regex, ` +
            `a glob filter (e.g. "*.ts"), a narrower path, or word_match: true.]`
          );
        }

        if (mode === "files_with_matches") {
          const fileList = Array.from(files);
          const limited = fileList.slice(0, effectiveLimit);
          const text = limited.join("\n") || "(no matches)";
          return {
            content: [{ type: "text", text: text + makeHint(files.size) }],
            details: { files: limited, count: limited.length },
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
          details: { matches: limitedMatches, count: limitedMatches.length },
        };
      } catch (err: any) {
        if (err.code === "ENOENT") {
          return {
            content: [{ type: "text", text: "ripgrep (rg) not found in PATH" }],
            details: { error: "rg not found" },
          };
        }
        if (err.status === 1 && !err.stderr) {
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
