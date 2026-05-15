// @ts-nocheck

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const POSSIBLE_RG_PATHS = [
  "rg",
  `${process.env.USERPROFILE}\\.pi\\agent\\bin\\rg.exe`,
  `${process.env.USERPROFILE}\\AppData\\Local\\Microsoft\\WinGet\\Packages\\BurntSushi.ripgrep*\\ripgrep-*-x86_64-pc-windows-msvc\\rg.exe`,
  `C:\\Program Files\\ripgrep\\rg.exe`,
  `C:\\ProgramData\\chocolatey\\bin\\rg.exe`,
  `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\BurntSushi.ripgrep*\\ripgrep-*-x86_64-pc-windows-msvc\\rg.exe`,
];

function findRg(): string | null {
  for (const p of POSSIBLE_RG_PATHS) {
    try {
      // For plain "rg", try execFileSync with --version
      if (p === "rg") {
        const { execFileSync } = require("node:child_process");
        execFileSync("rg", ["--version"], { stdio: "ignore", windowsHide: true });
        return "rg";
      }
      // Check file existence for absolute paths
      const fs = require("node:fs");
      if (fs.existsSync(p)) {
        return p;
      }
    } catch {
      // continue
    }
  }
  return null;
}

interface GrepMatch {
  file: string;
  line_number: number;
  content: string;
  match?: string;
}

function resolvePath(raw: string): string {
  if (!raw) return ".";
  const trimmed = raw.replace(/^["']|["']$/g, "");
  return trimmed;
}

export default function (pi: any) {
  pi.registerTool({
    name: "grep",
    label: "Grep",
    description:
      "Fast structured search via ripgrep. Respects .gitignore, skips hidden files, " +
      "supports filters by glob/type, context lines, case-insensitive search, and multiple output modes. " +
      "Safer and easier to parse than raw shell grep.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regular expression to search for",
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
          description: "Limit total results to first N matches",
        },
        include_ignored: {
          type: "boolean",
          description: "Search in files ignored by .gitignore. Still excludes .env for safety.",
        },
      },
      required: ["pattern"],
    },
    execute: async (_toolCallId: string, params: any) => {
      const cwd = process.cwd();
      const args: string[] = ["--json", "--color", "never"];

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
        args.push("-uu"); // disregard .gitignore and hidden files
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
          content: [{ type: "text", text: "ripgrep (rg) not found in PATH or common install locations" }],
          details: { error: "rg not found" },
        };
      }

      try {
        const { stdout } = await execFileAsync(rgPath, args, {
          cwd,
          maxBuffer: 2 * 1024 * 1024, // 2 MB
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

        const headLimit = params.head_limit;
        const mode = params.output_mode || "content";

        if (mode === "files_with_matches") {
          const fileList = Array.from(files);
          const limited = headLimit ? fileList.slice(0, headLimit) : fileList;
          return {
            content: [
              { type: "text", text: limited.join("\n") || "(no matches)" },
            ],
            details: { files: limited, count: limited.length },
          };
        }

        if (mode === "count_matches") {
          return {
            content: [{ type: "text", text: String(totalMatches) }],
            details: { count: totalMatches },
          };
        }

        // content mode
        const limitedMatches = headLimit ? matches.slice(0, headLimit) : matches;
        const text = limitedMatches.length
          ? limitedMatches
              .map((m) => `${m.file}:${m.line_number}: ${m.content}`)
              .join("\n")
          : "(no matches)";

        return {
          content: [{ type: "text", text }],
          details: { matches: limitedMatches, count: limitedMatches.length },
        };
      } catch (err: any) {
        if (err.code === "ENOENT") {
          return {
            content: [{ type: "text", text: "ripgrep (rg) not found in PATH" }],
            details: { error: "rg not found" },
          };
        }
        // rg exits 1 when no matches — treat as empty result
        if (err.status === 1 && !err.stderr) {
          return {
            content: [{ type: "text", text: "(no matches)" }],
            details: { count: 0 },
          };
        }
        return {
          content: [
            { type: "text", text: `Grep error: ${err.stderr || err.message}` },
          ],
          details: { error: err.stderr || err.message },
        };
      }
    },
  });
}
