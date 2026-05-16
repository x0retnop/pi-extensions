// Win Bash Sanitizer — sanitizes bash tool calls for Git Bash on Windows.
// Fixes: Windows paths with spaces, cmd fallbacks (|| dir), 2>nul, broken quotes.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  if (process.platform !== "win32") return;

  // Lightweight ephemeral hint for the LLM (does not bloat the system prompt)
  pi.on("before_agent_start", async () => ({
    message: {
      customType: "win-bash-rules",
      content: [
        "You are on Windows with Git Bash.",
        "Path rules: use '/c/...' instead of 'C:\\\\'. Wrap spaced paths in SINGLE quotes.",
        "Redirection: use '2>/dev/null', never '2>nul'.",
        "Listing: use 'ls', never 'dir'. Do NOT use '|| dir ...' fallbacks.",
        "Never end a quoted path with backslash: WRONG: \"C:\\\\dir\\\\\"  RIGHT: '/c/dir'",
      ].join("\n"),
      display: false,
    },
  }));

  // Intercept and sanitize bash commands
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    let cmd: string = event.input.command;
    const original = cmd;
    let modified = false;

    // Rule A: strip cmd fallback "|| dir ..." or "&& dir ..."
    const fallbackRegex = /^(.*?)\s*(?:\|\||&&)\s*dir\b.*$/i;
    const fallbackMatch = cmd.match(fallbackRegex);
    if (fallbackMatch) {
      cmd = fallbackMatch[1].trim();
      modified = true;
    }

    // Rule B: replace cmd redirects
    if (/\b2>nul\b/i.test(cmd)) {
      cmd = cmd.replace(/\b2>nul\b/g, "2>/dev/null");
      modified = true;
    }
    if (/\bnul\b/i.test(cmd)) {
      cmd = cmd.replace(/\bnul\b/g, "/dev/null");
      modified = true;
    }

    // Rule C: replace dir with ls
    cmd = cmd.replace(/\bdir\s+([^\s].*?)\s*\/b\b/gi, (_, p) => {
      modified = true;
      return `ls -1 ${toBashPath(p)}`;
    });
    cmd = cmd.replace(/\bdir\s+([^\s].*?)\b/gi, (_, p) => {
      modified = true;
      return `ls ${toBashPath(p)}`;
    });

    // Rule D: fix Windows paths and quotes
    cmd = fixWindowsPaths(cmd);
    if (cmd !== original) modified = true;

    // Rule E: remove backslash escapes before ordinary characters
    // In bash, \ before a normal letter just removes the slash.
    // Keep only \ before space (escaped space) and inside quotes.
    cmd = cmd.replace(/\\([^\s"'\\])/g, (match, _char, offset) => {
      const before = cmd.slice(0, offset);
      const quotes = before.match(/'/g);
      if (quotes && quotes.length % 2 !== 0) return match; // inside single quotes
      modified = true;
      return _char;
    });

    if (modified) {
      event.input.command = cmd;
      ctx.ui?.notify?.(`Git Bash fix: ${original} → ${cmd}`, "info");
    }

    // Rule F: quote balance check
    const dbl = (cmd.match(/"/g) || []).length;
    const sgl = (cmd.match(/'/g) || []).length;
    if (dbl % 2 !== 0 || sgl % 2 !== 0) {
      return {
        block: true,
        reason: `Quote mismatch after sanitization. Command: ${cmd}\nPlease rewrite using single quotes for Windows paths.`,
      };
    }
  });
}

// Helpers

function fixWindowsPaths(cmd: string): string {
  // 1. Paths inside double quotes: "C:\foo\bar" or "C:\foo bar\baz"
  cmd = cmd.replace(/"([A-Za-z]:\\(?:[^"]|\\.)*)"/g, (_match, inner) => {
    let p = inner.replace(/\\"/g, '"').replace(/\\/g, "/").replace(/^([A-Za-z]):\//, "/$1/");
    p = p.replace(/\/$/, ""); // strip trailing /
    if (p.includes(" ")) return `'${p}'`;
    return p;
  });

  // 2. Unquoted paths: tokens starting with C:\ (with \-escape for spaces)
  let result = "";
  let i = 0;
  while (i < cmd.length) {
    const m = cmd.slice(i).match(/^([A-Za-z]):\\((?:[^ \t\n\r"']|\\.)+)/);
    if (m) {
      let p = m[0]
        .replace(/\\([ \t\n\r"'])/g, "$1")
        .replace(/\\/g, "/")
        .replace(/^([A-Za-z]):\//, "/$1/");
      p = p.replace(/\/$/, "");
      result += p.includes(" ") ? `'${p}'` : p;
      i += m[0].length;
    } else {
      result += cmd[i];
      i++;
    }
  }
  return result;
}

function toBashPath(expr: string): string {
  let p = expr.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  p = p.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, "/$1/").replace(/\/$/, "");
  if (p.includes(" ")) return `'${p}'`;
  return p;
}
