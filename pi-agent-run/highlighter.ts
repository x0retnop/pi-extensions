import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { HighlightMode } from "./settings.js";

const PS_KEYWORDS = new Set([
  "begin", "break", "catch", "class", "continue", "data", "define",
  "do", "dynamicparam", "else", "elseif", "end", "enum", "exit", "filter",
  "finally", "for", "foreach", "from", "function", "if", "in", "param",
  "process", "return", "switch", "throw", "trap", "try", "until", "using",
  "var", "while", "workflow", "parallel", "sequence", "inlinescript",
  "hidden", "static", "public", "private", "protected", "internal",
]);

const PS_OPERATORS = new Set([
  "-eq", "-ne", "-gt", "-ge", "-lt", "-le", "-like", "-notlike",
  "-match", "-notmatch", "-contains", "-notcontains", "-in", "-notin",
  "-replace", "-split", "-join", "-is", "-isnot", "-as", "-and", "-or",
  "-xor", "-not", "-band", "-bor", "-bxor", "-bnot", "-f", "-ceq", "-cne",
  "-cgt", "-cge", "-clt", "-cle", "-clike", "-cnotlike", "-cmatch",
  "-cnotmatch", "-ccontains", "-cnotcontains", "-cin", "-cnotin",
  "-creplace",
]);

const PS_APPROVED_VERBS = new Set([
  "Add", "Approve", "Assert", "Backup", "Block", "Build", "Checkpoint",
  "Clear", "Close", "Compare", "Complete", "Compress", "Confirm", "Connect",
  "Convert", "ConvertFrom", "ConvertTo", "Copy", "Debug", "Deny", "Disable",
  "Disconnect", "Dismount", "Edit", "Enable", "Enter", "Exit", "Expand",
  "Export", "Format", "Get", "Grant", "Group", "Hide", "Import", "Initialize",
  "Install", "Invoke", "Join", "Limit", "Lock", "Measure", "Merge", "Mount",
  "Move", "New", "Open", "Optimize", "Out", "Ping", "Pop", "Protect", "Publish",
  "Push", "Read", "Receive", "Redo", "Register", "Remove", "Rename", "Repair",
  "Request", "Reset", "Resize", "Resolve", "Restart", "Restore", "Resume",
  "Revoke", "Save", "Search", "Select", "Send", "Set", "Show", "Skip", "Split",
  "Start", "Step", "Stop", "Submit", "Suspend", "Switch", "Sync", "Test",
  "Trace", "Unblock", "Undo", "Uninstall", "Unlock", "Unprotect", "Unpublish",
  "Unregister", "Update", "Use", "Wait", "Watch", "Where", "Write",
]);

function isPsCmdlet(token: string): boolean {
  if (!token || token.length < 3) return false;
  const parts = token.split("-");
  if (parts.length !== 2) return false;
  const [verb, noun] = parts;
  if (!verb || !noun) return false;
  return PS_APPROVED_VERBS.has(verb) && /^[A-Z]/.test(noun);
}

type ThemeColor = Parameters<Theme["fg"]>[0];
/** Syntax tokens the PowerShell tokenizer paints; a subset of the theme's fg tokens. */
type SyntaxColor = Extract<ThemeColor, `syntax${string}`>;

function color(theme: Theme, colorName: SyntaxColor, text: string): string {
  return theme.fg(colorName, text);
}

function tokenizePs(code: string, theme: Theme): string {
  const result: string[] = [];
  let i = 0;

  function emit(kind: SyntaxColor, text: string) {
    result.push(color(theme, kind, text));
  }

  while (i < code.length) {
    const ch = code[i];

    // Block comment <# ... #>
    if (ch === "<" && code.slice(i, i + 2) === "<#") {
      const end = code.indexOf("#>", i + 2);
      const text = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      emit("syntaxComment", text);
      i += text.length;
      continue;
    }

    // Line comment # ...
    if (ch === "#") {
      const end = code.indexOf("\n", i);
      const text = end === -1 ? code.slice(i) : code.slice(i, end);
      emit("syntaxComment", text);
      i += text.length;
      continue;
    }

    // Here-string @" ... "@ or @' ... '@
    if (ch === "@" && (code[i + 1] === '"' || code[i + 1] === "'")) {
      const quote = code[i + 1];
      const terminator = quote === '"' ? '"@' : "'@";
      const end = code.indexOf(terminator, i + 2);
      const text = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      emit("syntaxString", text);
      i += text.length;
      continue;
    }

    // Double-quoted string with variable interpolation. Backtick escapes the next char.
    if (ch === '"') {
      let j = i + 1;
      while (j < code.length) {
        const c = code[j];
        if (c === '`' && j + 1 < code.length) {
          j += 2;
          continue;
        }
        if (c === '"') break;
        if (c === "$" && code[j + 1] === "(") {
          // Subexpression in string: leave it as string color for simplicity
        }
        j++;
      }
      if (j < code.length) j++;
      emit("syntaxString", code.slice(i, j));
      i = j;
      continue;
    }

    // Single-quoted string. Backtick is literal in single-quoted strings in PowerShell;
    // a single quote inside is escaped by doubling: 'it''s'.
    if (ch === "'") {
      let j = i + 1;
      while (j < code.length) {
        const c = code[j];
        if (c === "'" && code[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (c === "'") break;
        j++;
      }
      if (j < code.length) j++;
      emit("syntaxString", code.slice(i, j));
      i = j;
      continue;
    }

    // Variables $var, $env:PATH, ${...}, $?
    if (ch === "$") {
      let j = i + 1;
      if (code[j] === "{") {
        const end = code.indexOf("}", j);
        const text = end === -1 ? code.slice(i) : code.slice(i, end + 1);
        emit("syntaxVariable", text);
        i += text.length;
        continue;
      }
      // Single-character special variables: $?, $_, $$, $^
      if (/[?_\^$]/.test(code[j])) {
        emit("syntaxVariable", code.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      while (j < code.length && /[A-Za-z0-9_:]/.test(code[j])) j++;
      emit("syntaxVariable", code.slice(i, j));
      i = j;
      continue;
    }

    // Numbers (decimal, hex 0x..., binary 0b..., scientific)
    if (/\d/.test(ch) || (ch === "." && /\d/.test(code[i + 1]))) {
      let j = i;
      if (ch === "0" && /[xXbBoO]/.test(code[i + 1])) {
        j += 2;
        while (j < code.length && /[\da-fA-F]/.test(code[j])) j++;
      } else {
        while (j < code.length && /[\d.]/.test(code[j])) j++;
        if (/[eE]/.test(code[j]) && /[+-]?\d/.test(code[j + 1])) {
          j++;
          if (/[+-]/.test(code[j])) j++;
          while (j < code.length && /\d/.test(code[j])) j++;
        }
      }
      // kb/mb/gb/tb suffixes
      while (j < code.length && /[kKmMgGtTbB]/.test(code[j])) j++;
      emit("syntaxNumber", code.slice(i, j));
      i = j;
      continue;
    }

    // Type literals [string], [System.IO.File]
    if (ch === "[") {
      const end = code.indexOf("]", i);
      if (end !== -1) {
        emit("syntaxType", code.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }

    // Identifiers / keywords / cmdlets (may contain dashes for cmdlet names)
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < code.length && /[A-Za-z0-9_]/.test(code[j])) j++;
      // Absorb dash-separated continuation (e.g. Get-Process, Where-Object)
      while (
        j < code.length &&
        code[j] === "-" &&
        /[A-Za-z_]/.test(code[j + 1])
      ) {
        j++; // absorb '-'
        while (j < code.length && /[A-Za-z0-9_]/.test(code[j])) j++;
      }
      const token = code.slice(i, j);
      const lower = token.toLowerCase();
      if (PS_KEYWORDS.has(lower)) {
        emit("syntaxKeyword", token);
      } else if (isPsCmdlet(token)) {
        emit("syntaxFunction", token);
      } else if (PS_OPERATORS.has(lower)) {
        emit("syntaxOperator", token);
      } else {
        emit("syntaxVariable", token);
      }
      i = j;
      continue;
    }

    // Standalone operators starting with -
    if (ch === "-" && /[A-Za-z]/.test(code[i + 1])) {
      let j = i + 1;
      while (j < code.length && /[A-Za-z]/.test(code[j])) j++;
      const token = code.slice(i, j);
      if (PS_OPERATORS.has(token.toLowerCase())) {
        emit("syntaxOperator", token);
      } else {
        emit("syntaxVariable", token);
      }
      i = j;
      continue;
    }

    // Operators and punctuation
    if (/[|&<>!=%+*/^~,;:.?@]/.test(ch)) {
      emit("syntaxOperator", ch);
      i++;
      continue;
    }

    if (/[(){}\[\]]/.test(ch)) {
      emit("syntaxPunctuation", ch);
      i++;
      continue;
    }

    // Whitespace / anything else
    result.push(ch);
    i++;
  }

  return result.join("");
}

type ToolName = "pwsh" | "py";

const DEFAULT_MODES: Record<ToolName, HighlightMode> = {
  pwsh: "powershell",
  py: "python",
};

export function highlightCodeSafe(
  code: string,
  lang: HighlightMode,
  theme: Theme,
  tool?: ToolName,
): string[] {
  if (lang === "none") {
    return code.split("\n").map((line) => theme.fg("toolOutput", line));
  }

  const effectiveLang = lang === "auto"
    ? (tool && tool in DEFAULT_MODES ? DEFAULT_MODES[tool] : "powershell")
    : lang;

  if (effectiveLang === "powershell") {
    return code.split("\n").map((line) => tokenizePs(line, theme));
  }

  // Python or anything else -> use Pi's built-in highlighter
  try {
    return highlightCode(code, effectiveLang);
  } catch {
    return code.split("\n").map((line) => theme.fg("toolOutput", line));
  }
}
