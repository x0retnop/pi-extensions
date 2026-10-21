import { readFile } from "node:fs/promises";

export interface Section {
  name: string;
  type: string;
  startLine: number; // 1-indexed
}

export interface OverviewResult {
  sections: Section[];
  totalLines: number;
  sizeBytes: number;
}

export interface SectionExtractResult {
  lines: string[];
  startLine: number;
  endLine: number;
  blockEndDetected: boolean;
  blockTruncated: boolean;
  totalBlockLines?: number;
}

export interface LanguageHandler {
  extensions: string[];
  extractName(line: string): { name: string; type: string } | null;
  sectionStartRegex(target: string): RegExp;
  findBlockEnd?(lines: string[], startIdx: number): number | null;
  /** Expand start upward (e.g. Python decorators). Block-end still uses defIdx. */
  expandSectionStart?(lines: string[], defIdx: number): number;
  /** Stateful skip for overview/section (fences, etc.). Must see every line in order. true = ignore. */
  createIgnoreTracker?(): (line: string) => boolean;
}

const jsFamilyKeywords = new Set([
  "if", "while", "for", "switch", "catch", "with", "else", "do", "try", "finally",
  "let", "const", "var", "function", "class", "return",
]);

/** Access / storage modifiers shared by C# type + member patterns (space-separated runs). */
const CS_MOD =
  "(?:public|private|protected|internal|static|abstract|virtual|override|sealed|partial|readonly|const|async|extern|unsafe|new|volatile|required|file|protected\\s+internal|private\\s+protected)";

const csTypeKeywords = new Set([
  "class", "struct", "interface", "enum", "record", "delegate", "event",
]);

const csFalseNames = new Set([
  ...jsFamilyKeywords,
  "foreach", "using", "lock", "fixed", "checked", "unchecked", "nameof", "typeof",
  "sizeof", "stackalloc", "await", "yield", "throw", "when", "from", "select",
  "where", "join", "group", "orderby", "let", "into", "on", "equals", "by",
  "ascending", "descending", "not", "and", "or", "is", "as", "in", "out", "ref",
  "params", "this", "base", "value", "get", "set", "init", "add", "remove",
  "global", "alias", "nint", "nuint", "var", "dynamic", "object", "string",
  "int", "long", "short", "byte", "bool", "char", "float", "double", "decimal",
  "void", "task",
]);

/** First token that means statement / call noise, not a return type. */
const csStmtStarters = new Set([
  "if", "else", "for", "foreach", "while", "do", "switch", "case", "return",
  "throw", "using", "lock", "fixed", "await", "yield", "new", "checked",
  "unchecked", "sizeof", "typeof", "nameof", "when", "from", "break", "continue",
  "goto", "try", "catch", "finally",
]);

function stripCsPrefix(line: string): string {
  // leading attrs [Foo] [Bar(x)] and modifiers
  let s = line.replace(/^\s+/, "");
  // attributes may nest-ish brackets rarely; single-level is enough for overview
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/^\[[^\[\]]*\]\s*/, "");
    if (next === s) break;
    s = next;
  }
  // modifier run
  const modRe = new RegExp(`^(?:${CS_MOD})\\s+`, "i");
  for (let i = 0; i < 12; i++) {
    const next = s.replace(modRe, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

function extractCsharpName(line: string): { name: string; type: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
    return null;
  }

  const body = stripCsPrefix(line);

  // record struct Foo / record class Foo / record Foo
  const recordMatch = body.match(/^record(?:\s+(struct|class))?\s+(\w+)\b/);
  if (recordMatch) {
    return { name: recordMatch[2], type: recordMatch[1] ? `record ${recordMatch[1]}` : "record" };
  }

  // class / struct / interface / enum / delegate
  const typeMatch = body.match(/^(class|struct|interface|enum|delegate)\s+(\w+)\b/);
  if (typeMatch) {
    return { name: typeMatch[2], type: typeMatch[1] };
  }

  // event fields: event EventHandler Name; (not very useful; skip bare "event" type keyword noise)
  // Methods / ctors: require that the original line had at least one access/mod keyword
  // (strips them) OR looks like an explicit signature with a return type — never bare calls.
  const hadModifier = /^\s*(?:\[[^\]]*\]\s*)*(?:public|private|protected|internal)\b/i.test(line);
  if (!hadModifier) {
    // Interface-style / file-local: must start with a type token, not `else Foo()` / `throw new`
    if (/^(?:\?|\.|:)/.test(trimmed) || /\bthrow\b|\breturn\b/.test(trimmed)) {
      return null;
    }
    const iface = trimmed.match(
      /^([A-Za-z_][\w.<>\[\],?\s]*?)\s+(\w+)\s*\([^;{}]*\)\s*(?:where\b.*)?(?:\{|=>|;)\s*$/
    );
    if (iface) {
      const first = (iface[1].trim().split(/\s+/)[0] || "").replace(/<.*>/, "");
      const name = iface[2];
      if (
        !csStmtStarters.has(first) &&
        !csFalseNames.has(name) &&
        !csTypeKeywords.has(name)
      ) {
        return { name, type: "method" };
      }
    }
    return null;
  }

  // constructor / destructor: Name( or ~Name(
  const ctor = body.match(/^(~?\w+)\s*\(/);
  if (ctor) {
    const name = ctor[1];
    if (!csFalseNames.has(name.replace(/^~/, "")) && !csTypeKeywords.has(name)) {
      // Distinguish ctor from method: no return-type tokens before name (body starts with name)
      return { name, type: name.startsWith("~") ? "destructor" : "constructor" };
    }
  }

  // method: ReturnType Name( ... ) then { / => / ; / end (brace-next-line) / one-liner body
  const method = body.match(
    /^(?:[\w.<>\[\],?\s]+?)\s+(\w+)\s*\([^;{}]*\)(?:\s*where\b[^{;]*)?(?:\s*(?:\{|=>|;).*|\s*)$/
  );
  if (method) {
    const name = method[1];
    if (!csFalseNames.has(name) && !csTypeKeywords.has(name)) {
      return { name, type: "method" };
    }
  }

  // Multi-line signature: "ReturnType Name(..." with unclosed paren (brace on later line)
  const openMethod = body.match(/^(?:[\w.<>\[\],?\s]+?)\s+(\w+)\s*\([^)]*$/);
  if (openMethod) {
    const name = openMethod[1];
    if (!csFalseNames.has(name) && !csTypeKeywords.has(name)) {
      return { name, type: "method" };
    }
  }
  const openCtor = body.match(/^(~?\w+)\s*\([^)]*$/);
  if (openCtor) {
    const name = openCtor[1];
    if (!csFalseNames.has(name.replace(/^~/, "")) && !csTypeKeywords.has(name)) {
      return { name, type: name.startsWith("~") ? "destructor" : "constructor" };
    }
  }

  // Properties: Type Name { get ... } / =>  (not methods — no '(' before brace)
  const prop = body.match(/^(?:[\w.<>\[\],?\s]+?)\s+(\w+)\s*(?:\{|=>)/);
  if (prop && !body.includes("(")) {
    const name = prop[1];
    if (!csFalseNames.has(name) && !csTypeKeywords.has(name)) {
      return { name, type: "property" };
    }
  }

  return null;
}

function csharpSectionStartRegex(target: string): RegExp {
  const t = escapeRegex(target);
  // Types
  const typePart =
    `^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:${CS_MOD}\\s+)*(?:record\\s+(?:struct|class)\\s+|record\\s+|class\\s+|struct\\s+|interface\\s+|enum\\s+|delegate\\s+)${t}\\b`;
  // Members: access modifier required (kills call-sites), then optional return type, then name(
  // or property name { / =>
  const memberPart =
    `^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:${CS_MOD}\\s+)+(?:[\\w.<>\\[\\],?\\s]+?\\s+)?${t}\\s*(?:\\(|\\{|=>)`;
  return new RegExp(`${typePart}|${memberPart}`, "i");
}

const csharpHandler: LanguageHandler = {
  extensions: [".cs"],
  extractName: extractCsharpName,
  sectionStartRegex: csharpSectionStartRegex,
  findBlockEnd: findBraceBlockEnd,
};

// --- C / C++ -----------------------------------------------------------------

/** Names that cannot be a function/method identifier. */
const cppFalseNames = new Set([
  "if", "while", "for", "switch", "catch", "else", "do", "try", "finally",
  "return", "break", "continue", "goto", "case", "default", "new", "delete",
  "static_cast", "dynamic_cast", "const_cast", "reinterpret_cast",
  "sizeof", "typeof", "decltype", "typeid", "throw", "using", "namespace",
  "template", "typename", "const", "volatile", "mutable", "constexpr", "consteval",
  "constinit", "inline", "static", "extern", "virtual", "explicit", "friend",
  "operator", "public", "private", "protected", "class", "struct", "enum",
  "union", "concept", "requires", "co_await", "co_return", "co_yield",
  "true", "false", "nullptr", "this",
]);

/** First token of a "return type" that means this is a statement, not a definition. */
const cppStmtStarters = new Set([
  "if", "while", "for", "switch", "catch", "else", "do", "try", "return",
  "break", "continue", "goto", "case", "default", "throw", "delete", "sizeof",
  "co_await", "co_return", "co_yield", "static_assert", "using",
]);

const CPP_SPEC =
  "(?:inline|static|virtual|constexpr|consteval|constinit|explicit|friend|extern|noexcept|override|final|const|volatile|mutable|typename|template)";

function stripCppLeading(line: string): string {
  let s = line.replace(/^\s+/, "");
  // template <...> (non-nested approx)
  s = s.replace(/^template\s*<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*/i, "");
  const specRe = new RegExp(`^(?:${CPP_SPEC})\\s+`);
  for (let i = 0; i < 10; i++) {
    const next = s.replace(specRe, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

function extractCppName(line: string): { name: string; type: string } | null {
  const trimmed = line.trim();
  if (
    !trimmed ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("}")
  ) {
    return null;
  }

  // Forward declarations: class Foo; struct Bar; — skip (noise in overview)
  if (/^(?:template\s*<[^>]*>\s*)?(?:class|struct|union)\s+[\w:]+\s*;\s*$/.test(trimmed)) {
    return null;
  }

  // enum class / enum struct / enum Name
  const enumClass = trimmed.match(/^(?:template\s*<[^>]*>\s*)?enum\s+(?:class|struct)\s+([\w:]+)/);
  if (enumClass) {
    return { name: enumClass[1], type: "enum class" };
  }
  const enumPlain = trimmed.match(/^(?:template\s*<[^>]*>\s*)?enum\s+([\w:]+)/);
  if (enumPlain) {
    return { name: enumPlain[1], type: "enum" };
  }

  // class / struct / union / namespace / concept
  const typeMatch = trimmed.match(
    /^(?:template\s*<[^>]*>\s*)?(class|struct|union|namespace|concept)\s+([\w:]+)/
  );
  if (typeMatch) {
    // "namespace {" anonymous — rare; name would be "{"
    if (typeMatch[2] === "{" || cppFalseNames.has(typeMatch[2])) return null;
    return {
      name: typeMatch[2],
      type: typeMatch[1] === "namespace" ? "namespace" : typeMatch[1] === "concept" ? "concept" : typeMatch[1],
    };
  }

  // Out-of-line definitions only (not calls like BehaviorLog::MonAt(…)):
  //   Ret Type::method(…   |  Type::Type(…  |  Type::~Type(…
  // Reject statement prefixes (`return std::sqrt`).
  if (!cppStmtStarters.has(trimmed.split(/\s+/)[0]?.replace(/[^A-Za-z_].*$/, "") ?? "")) {
    // ctor / dtor — no return type: Class::Class( / Class::~Class(
    const ctor2 = trimmed.match(
      /^(?:template\s*<[^>]*>\s*)*(?:inline\s+|constexpr\s+)*((?:[\w]+::)*([\w]+))::(~?\2)\s*\(/
    );
    if (ctor2) {
      const cls = ctor2[1];
      const method = ctor2[3];
      return {
        name: `${cls}::${method}`,
        type: method.startsWith("~") ? "destructor" : "constructor",
      };
    }

    // method with required return type containing a letter
    const qual = trimmed.match(
      /^(?:template\s*<[^>]*>\s*)*(?:[\w:<>,\s\*&]*[A-Za-z_][\w:<>,\s\*&]*\s+)((?:[\w]+::)*[\w]+)::(~?[\w]+|operator\s*[^\s(]+)\s*\(/
    );
    if (qual) {
      const cls = qual[1];
      const method = qual[2].replace(/\s+/g, " ").trim();
      const bare = method.replace(/^~/, "");
      if (method.startsWith("operator")) {
        return { name: `${cls}::${method}`, type: "operator" };
      }
      if (!cppFalseNames.has(bare)) {
        // Class::Class with return type is rare; still label as function
        return { name: `${cls}::${method}`, type: "function" };
      }
    }
  }

  // Free function or inline member: needs a real return-type prefix (not `return`/`if`/…)
  const body = stripCppLeading(trimmed);
  // Return type must include a letter (rejects ": ModeName(" ternary junk)
  const retName = body.match(/^((?:[\w:<>,\s\*&]*[A-Za-z_][\w:<>,\s\*&]*))\s+(\w+)\s*\(/);
  if (retName) {
    const retTokens = retName[1].trim().split(/[\s*&]+/).filter(Boolean);
    const firstRet = (retTokens[0] || "").toLowerCase().replace(/<.*>/, "");
    if (cppStmtStarters.has(firstRet)) {
      return null;
    }
    const name = retName[2];
    if (cppFalseNames.has(name)) return null;

    const afterParams =
      /^.+\([^;{}]*\)\s*(?:const\s*)?(?:noexcept(?:\s*\([^)]*\))?\s*)?(?:override\s*)?(?:final\s*)?(?:->\s*[\w:<>,\s\*&]+)?\s*(?:(\{)|(=)|(;))/;
    const m = body.match(afterParams);
    if (m) {
      // `Type name(...);` local vars vs declarations:
      // keep if brace body, =default/=delete, or method-like name (A-Z) / explicit virtual-ish
      if (m[1]) {
        return { name, type: "function" };
      }
      if (m[2] && /=\s*(?:default|delete)\b/.test(body)) {
        return { name, type: "function" };
      }
      if (m[3]) {
        const methodLike = /^[A-Z]/.test(name) || /\b(?:virtual|override|final|0)\b/.test(body);
        // pure/decl at class indent, or free decl at column 0
        if (methodLike) {
          return { name, type: "function" };
        }
        return null; // e.g. Vec2 dest(x, y);
      }
    }
    // Multi-line signature start (unclosed paren)
    if (/^.+\([^)]*$/.test(body) && /^\s{0,4}\S/.test(line) && /^[A-Z]/.test(name)) {
      return { name, type: "function" };
    }
  }

  return null;
}

function cppSectionStartRegex(target: string): RegExp {
  const t = escapeRegex(target);
  // Allow target "Foo" or "Cls::Foo" or "Cls::Foo" with operator forms
  let cls = "";
  let method = t;
  const qi = target.lastIndexOf("::");
  if (qi >= 0) {
    cls = escapeRegex(target.slice(0, qi));
    method = escapeRegex(target.slice(qi + 2));
  }

  const typePart =
    `^\\s*(?:template\\s*<[^>]*>\\s*)?(?:enum\\s+(?:class|struct)\\s+|enum\\s+|class\\s+|struct\\s+|union\\s+|namespace\\s+|concept\\s+)${t}\\b`;

  // Qualified out-of-line: ... Cls::method(  or exact Cls::method when target qualified
  const qualPart = cls
    ? `^\\s*(?:template\\s*<[^>]*>\\s*)?(?:[\\w:<>,\\s\\*&]+?\\s+)?${cls}::${method}\\s*\\(`
    : `^\\s*(?:template\\s*<[^>]*>\\s*)?(?:[\\w:<>,\\s\\*&]+?\\s+)?[\\w:]+::${method}\\s*\\(`;

  // Unqualified definition-like: return type + name(
  // Negative lookahead blocks statement keywords (return/if/while/…) as fake return types
  const freePart =
    `^\\s*(?:template\\s*<[^>]*>\\s*)?(?:${CPP_SPEC}\\s+)*(?!(?:return|if|else|while|for|switch|catch|sizeof|delete|typeof|decltype)\\b)(?:[\\w:<>,\\s\\*&]+?\\s+)${method}\\s*\\(`;

  return new RegExp(`${typePart}|${qualPart}|${freePart}`);
}

const cppHandler: LanguageHandler = {
  extensions: [".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".hxx"],
  extractName: extractCppName,
  sectionStartRegex: cppSectionStartRegex,
  findBlockEnd: findCppBlockEnd,
};

const jsFamilyHandler: LanguageHandler = {
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  extractName(line: string): { name: string; type: string } | null {
    // export default function ( ... )  — anonymous entry (common in Pi extensions)
    if (/^\s*export\s+default\s+(async\s+)?function\s*\(/.test(line)) {
      return { name: "default", type: "function" };
    }
    // export default class Foo / export default async function foo / export function foo
    const topMatch = line.match(
      /^\s*(?:export\s+(?:default\s+)?)?(async\s+)?(function|class|interface|type|enum)\s+(\w+)/
    );
    if (topMatch) {
      return { name: topMatch[3], type: topMatch[2] || "declaration" };
    }
    // Module-level or export const fn = ... => / function (skip nested helpers)
    // Requires column-0 start so indent-2 locals inside functions are not overview noise.
    const constFn = line.match(
      /^(export\s+)?const\s+(\w+)\s*(?::\s*[^=;]+)?=\s*(async\s+)?(function\b|\([^;]*\)\s*(?::\s*[^=;{]+)?\s*=>)/
    );
    if (constFn) {
      return { name: constFn[2], type: constFn[3] ? "async const" : "const" };
    }
    const methodMatch = line.match(
      /^\s*(?:async\s+)?(?:get\s+|set\s+)?(?:\w+\s+)*(\w+)\s*\([^)]*\)\s*(?:\{|=>)/
    );
    if (methodMatch) {
      const name = methodMatch[1];
      if (name && !jsFamilyKeywords.has(name)) {
        return { name, type: "method" };
      }
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    if (target === "default") {
      return /^\s*export\s+default\s+(async\s+)?function\s*\(/i;
    }
    return new RegExp(
      `^\\s*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function|class|interface|type|enum)\\s+${t}\\b|` +
      `^(?:export\\s+)?const\\s+${t}\\s*(?::\\s*[^=;]+)?=\\s*(?:async\\s+)?(?:function\\b|\\()|` +
      `^\\s*(?:export\\s+)?(?:const|let|var)\\s+${t}\\b|` +
      `^\\s*(?:async\\s+)?(?:\\w+\\s+)*${t}\\s*\\(`,
      "i"
    );
  },
  findBlockEnd: findBraceBlockEnd,
};

const pythonHandler: LanguageHandler = {
  extensions: [".py"],
  extractName(line: string): { name: string; type: string } | null {
    // async def / def / class (decorators are separate lines — ignored here)
    const match = line.match(/^\s*(?:async\s+)?(class|def)\s+(\w+)/);
    if (match) {
      const kind = match[1];
      const isAsync = kind === "def" && /^\s*async\s+def\b/.test(line);
      return { name: match[2], type: isAsync ? "async def" : kind };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(`^\\s*(?:async\\s+)?(class|def)\\s+${t}\\b`, "i");
  },
  findBlockEnd: findPythonBlockEnd,
  expandSectionStart: expandPythonDecoratorStart,
};

/** CommonMark-lite: 3+ ` or ~ fences, 0-3 space indent. Headings inside are not structure. */
function createMarkdownFenceTracker(): (line: string) => boolean {
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  return (line: string): boolean => {
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      const marker = m[2];
      const ch = marker[0] as "`" | "~";
      const len = marker.length;
      const rest = m[3];
      if (fenceChar === null) {
        if (ch === "`" && rest.includes("`")) return false;
        fenceChar = ch;
        fenceLen = len;
        return true;
      }
      if (ch === fenceChar && len >= fenceLen && rest.trim() === "") {
        fenceChar = null;
        fenceLen = 0;
        return true;
      }
    }
    return fenceChar !== null;
  };
}

function markdownHeadingLevel(line: string): number | null {
  const m = /^( {0,3})(#{1,6})(?:[ \t]+|$)/.exec(line);
  return m ? m[2].length : null;
}

function extractMarkdownName(line: string): { name: string; type: string } | null {
  const m = /^( {0,3})(#{1,6})[ \t]+(.*)$/.exec(line);
  if (!m) return null;
  let name = m[3]
    .replace(/[ \t]+#*[ \t]*$/, "")
    .replace(/[ \t]*\{#[^}]*\}[ \t]*$/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
  if (!name) return null;
  return { name, type: `h${m[2].length}` };
}

function findMarkdownBlockEnd(lines: string[], startIdx: number): number | null {
  const startLevel = markdownHeadingLevel(lines[startIdx] ?? "");
  if (startLevel === null) return null;
  const ignore = createMarkdownFenceTracker();
  for (let i = 0; i <= startIdx && i < lines.length; i++) ignore(lines[i]);
  for (let i = startIdx + 1; i < lines.length; i++) {
    const skipped = ignore(lines[i]);
    if (skipped) continue;
    const lvl = markdownHeadingLevel(lines[i]);
    if (lvl !== null && lvl <= startLevel) return i - 1;
  }
  return lines.length - 1;
}

const markdownHandler: LanguageHandler = {
  extensions: [".md", ".mdx"],
  extractName: extractMarkdownName,
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(`^ {0,3}#{1,6}[ \\t]+.*\\b${t}\\b`, "i");
  },
  findBlockEnd: findMarkdownBlockEnd,
  createIgnoreTracker: createMarkdownFenceTracker,
};

function htmlHeadingLevel(line: string): number | null {
  const m = /<h([1-6])\b/i.exec(line);
  return m ? Number(m[1]) : null;
}

function htmlInnerText(raw: string): string {
  let s = raw.replace(/<\/h[1-6]\s*>/i, "");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return s.replace(/\s+/g, " ").trim();
}

function extractHtmlName(line: string): { name: string; type: string } | null {
  const m = /<h([1-6])\b([^>]*)>(.*)$/i.exec(line);
  if (!m) return null;
  let name = htmlInnerText(m[3]);
  if (!name) {
    const id = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(m[2]);
    name = (id?.[1] || id?.[2] || id?.[3] || "").trim();
  }
  if (!name) return null;
  return { name, type: `h${m[1]}` };
}

function findHtmlHeadingBlockEnd(lines: string[], startIdx: number): number | null {
  const startLevel = htmlHeadingLevel(lines[startIdx] ?? "");
  if (startLevel === null) return null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const lvl = htmlHeadingLevel(lines[i]);
    if (lvl !== null && lvl <= startLevel) return i - 1;
  }
  return lines.length - 1;
}

const htmlHandler: LanguageHandler = {
  extensions: [".html", ".htm"],
  extractName: extractHtmlName,
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(
      `<h[1-6]\\b[^>]*>[^\\n]*${t}|<h[1-6]\\b[^>]*${t}[^>]*>`,
      "i"
    );
  },
  findBlockEnd: findHtmlHeadingBlockEnd,
};

const jsonHandler: LanguageHandler = {
  extensions: [".json", ".jsonc"],
  extractName(line: string): { name: string; type: string } | null {
    const match = line.match(/^\s*"([^"]+)"\s*:/);
    if (match) {
      return { name: match[1], type: "key" };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(`^\\s*"${t}"\\s*:`, "i");
  },
};

const rustHandler: LanguageHandler = {
  extensions: [".rs"],
  extractName(line: string): { name: string; type: string } | null {
    // impl Trait for Type / impl Type / impl<T> Type
    const implMatch = line.match(
      /^\s*(?:pub(?:\([^)]*\))?\s+)?impl(?:\s*<[^>]*>)?\s+(?:([\w:]+)\s+for\s+)?([\w:]+)/
    );
    if (implMatch) {
      const name = implMatch[1] ? `${implMatch[1]} for ${implMatch[2]}` : implMatch[2];
      return { name, type: "impl" };
    }
    // pub(crate) async fn foo / pub fn / async fn / mod foo / struct ...
    const match = line.match(
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(async\s+)?(fn|struct|enum|trait|union|type|const|static|mod|macro_rules!)\s+(?:<[^>]+>\s+)?(\w+)/
    );
    if (match) {
      const kind = match[2];
      const isAsync = Boolean(match[1]) && kind === "fn";
      return { name: match[3], type: isAsync ? "async fn" : kind };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    // impl targets may be "Foo" or "Trait for Foo"
    const forParts = target.match(/^(\S+)\s+for\s+(\S+)$/);
    if (forParts) {
      const tr = escapeRegex(forParts[1]);
      const ty = escapeRegex(forParts[2]);
      return new RegExp(
        `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?impl(?:\\s*<[^>]*>)?\\s+${tr}\\s+for\\s+${ty}\\b`,
        "i"
      );
    }
    return new RegExp(
      `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:fn|struct|enum|trait|union|type|const|static|mod|macro_rules!)\\s+(?:<[^>]+>\\s+)?${t}\\b|` +
      `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?impl(?:\\s*<[^>]*>)?\\s+(?:[\\w:]+\\s+for\\s+)?${t}\\b`,
      "i"
    );
  },
  findBlockEnd: findBraceBlockEnd,
};

const javaHandler: LanguageHandler = {
  extensions: [".java"],
  extractName(line: string): { name: string; type: string } | null {
    const match = line.match(
      /^\s*(?:public|private|protected|static|final|abstract|synchronized|native|strictfp|default\s+)*\s*(class|interface|enum|record|annotation)\s+(?:\w+\s+)*?(\w+)/
    );
    if (match) {
      return { name: match[2], type: match[1] };
    }
    const methodMatch = line.match(
      /^\s*(?:public|private|protected|static|final|abstract|synchronized|native|strictfp)*\s*(?:[\w\<\>\[\]\,\s]+)\s+(\w+)\s*\([^)]*\)\s*(?:\{|throws\b)/
    );
    if (methodMatch) {
      const name = methodMatch[1];
      if (name && !jsFamilyKeywords.has(name)) {
        return { name, type: "method" };
      }
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(
      `^\\s*(?:public|private|protected|static|final|abstract|synchronized|native|strictfp|default\\s+)*\\s*(?:class|interface|enum|record|annotation)\\s+(?:\\w+\\s+)*?${t}\\b|` +
      `^\\s*(?:public|private|protected|static|final|abstract|synchronized|native|strictfp)*\\s*(?:[\\w\\<\\>\\[\\]\\,\\s]+)\\s+${t}\\s*\\(`,
      "i"
    );
  },
  findBlockEnd: findBraceBlockEnd,
};

const goHandler: LanguageHandler = {
  extensions: [".go"],
  extractName(line: string): { name: string; type: string } | null {
    const match = line.match(/^\s*(func|type|var|const)\s+(?:\([^)]*\)\s+)?(\w+)/);
    if (match) {
      return { name: match[2], type: match[1] };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(
      `^\\s*(?:func|type|var|const)\\s+(?:\\([^)]*\\)\\s+)?${t}\\b`,
      "i"
    );
  },
  findBlockEnd: findBraceBlockEnd,
};

const phpHandler: LanguageHandler = {
  extensions: [".php"],
  extractName(line: string): { name: string; type: string } | null {
    const match = line.match(
      /^\s*(?:abstract|final|private|protected|public|static\s+)*\s*(class|interface|trait|enum|function)\s+(?:\w+\s+)*?(\w+)/
    );
    if (match) {
      return { name: match[2], type: match[1] };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(
      `^\\s*(?:abstract|final|private|protected|public|static\\s+)*\\s*(?:class|interface|trait|enum|function)\\s+(?:\\w+\\s+)*?${t}\\b`,
      "i"
    );
  },
  findBlockEnd: findBraceBlockEnd,
};

const rubyHandler: LanguageHandler = {
  extensions: [".rb"],
  extractName(line: string): { name: string; type: string } | null {
    const match = line.match(/^\s*(class|module|def)\s+(?:([A-Z]\w*)::)?(\w+)/);
    if (match) {
      return { name: match[3], type: match[1] };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(`^\\s*(?:class|module|def)\\s+(?:[A-Z]\\w*::)*${t}\\b`, "i");
  },
  findBlockEnd: findEndBlockEnd,
};

const bashHandler: LanguageHandler = {
  extensions: [".sh", ".bash", ".zsh"],
  extractName(line: string): { name: string; type: string } | null {
    const match = line.match(/^\s*(?:function\s+)?(\w+)\s*\(\)/);
    if (match) {
      return { name: match[1], type: "function" };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(`^\\s*(?:function\\s+)?${t}\\s*\\(\\)`, "i");
  },
  findBlockEnd: findEndBlockEnd,
};

const sqlHandler: LanguageHandler = {
  extensions: [".sql"],
  extractName(line: string): { name: string; type: string } | null {
    const match = line.match(
      /^\s*(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE|TRIGGER|INDEX|SCHEMA|DATABASE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\"\[]?[\w]+[\"\]]?\s*\.\s*)?(?:[\"\[]?)(\w+)/i
    );
    if (match) {
      return { name: match[1], type: "object" };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(
      `^\\s*(?:CREATE|ALTER|DROP)\\s+(?:OR\\s+REPLACE\\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE|TRIGGER|INDEX|SCHEMA|DATABASE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:[\"\\[]?[\\w]+[\"\\]]?\\s*\\.\\s*)?(?:[\"\\[]?)${t}\\b`,
      "i"
    );
  },
};

const yamlHandler: LanguageHandler = {
  extensions: [".yaml", ".yml"],
  extractName(line: string): { name: string; type: string } | null {
    const match = line.match(/^(\s*)([A-Za-z_][\w\-]*)\s*:/);
    if (match && match[1].length === 0) {
      return { name: match[2], type: "key" };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(`^${t}\\s*:`, "i");
  },
};

const tomlHandler: LanguageHandler = {
  extensions: [".toml"],
  extractName(line: string): { name: string; type: string } | null {
    const match = line.match(/^\s*\[(?:[^\]]+)\]/);
    if (match) {
      const inner = match[0].slice(1, -1).trim();
      const name = inner.split(".")[inner.split(".").length - 1];
      return { name, type: inner.startsWith("[[") ? "array-of-tables" : "table" };
    }
    const keyMatch = line.match(/^\s*([A-Za-z_][\w\-]*)\s*=/);
    if (keyMatch) {
      return { name: keyMatch[1], type: "key" };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(`^\\s*\\[(?:\\[[^\\]]*\\]|[^\\]]*)${t}(?:\\.[^\\]]*)?\\]`, "i");
  },
};

const iniHandler: LanguageHandler = {
  extensions: [".ini", ".cfg", ".conf"],
  extractName(line: string): { name: string; type: string } | null {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]/);
    if (sectionMatch) {
      return { name: sectionMatch[1], type: "section" };
    }
    const keyMatch = line.match(/^\s*([A-Za-z_][\w\-]*)\s*=/);
    if (keyMatch) {
      return { name: keyMatch[1], type: "key" };
    }
    return null;
  },
  sectionStartRegex(target: string): RegExp {
    const t = escapeRegex(target);
    return new RegExp(`^\\s*\\[${t}\\]`, "i");
  },
};

const handlers: LanguageHandler[] = [
  jsFamilyHandler,
  pythonHandler,
  markdownHandler,
  htmlHandler,
  jsonHandler,
  csharpHandler,
  rustHandler,
  cppHandler,
  javaHandler,
  goHandler,
  phpHandler,
  rubyHandler,
  bashHandler,
  sqlHandler,
  yamlHandler,
  tomlHandler,
  iniHandler,
];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectLanguage(filePath: string): LanguageHandler | null {
  const lower = filePath.toLowerCase();
  for (const handler of handlers) {
    if (handler.extensions.some((ext) => lower.endsWith(ext))) {
      return handler;
    }
  }
  return null;
}

export async function buildOverview(filePath: string): Promise<OverviewResult> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const handler = detectLanguage(filePath);
  const sections: Section[] = [];

  if (handler) {
    const ignore = handler.createIgnoreTracker?.();
    for (let i = 0; i < lines.length; i++) {
      if (ignore?.(lines[i])) continue;
      const extracted = handler.extractName(lines[i]);
      if (extracted) {
        sections.push({ ...extracted, startLine: i + 1 });
      }
    }
  }

  return { sections, totalLines: lines.length, sizeBytes: Buffer.byteLength(content, "utf-8") };
}

export async function extractSection(
  filePath: string,
  target: string,
  limit: number
): Promise<SectionExtractResult | { candidates: { name: string; line: number }[] } | null> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const handler = detectLanguage(filePath);
  if (!handler) {
    return null;
  }

  // Normalize Class.method → Class::method for C-family qualified targets
  const normalizedTarget = target.includes(".") && !target.includes("::")
    ? target.replace(".", "::")
    : target;

  const regex = handler.sectionStartRegex(normalizedTarget);
  // Also try bare method name when agent passes Type::method and regex is exact-qualified only
  const bareTarget = normalizedTarget.includes("::")
    ? normalizedTarget.slice(normalizedTarget.lastIndexOf("::") + 2)
    : null;
  const bareRegex = bareTarget && bareTarget !== normalizedTarget
    ? handler.sectionStartRegex(bareTarget)
    : null;

  type Match = { name: string; type: string; line: number; idx: number; defined: boolean };
  const matches: Match[] = [];
  const ignore = handler.createIgnoreTracker?.();

  for (let i = 0; i < lines.length; i++) {
    if (ignore?.(lines[i])) continue;
    // reset lastIndex — section regexes are global-unsafe if /g ever set; keep sticky-safe
    regex.lastIndex = 0;
    if (bareRegex) bareRegex.lastIndex = 0;
    const extracted = handler.extractName(lines[i]);
    const regexHit = regex.test(lines[i]) || (bareRegex ? bareRegex.test(lines[i]) : false);
    const nameHit =
      extracted != null &&
      (extracted.name === target ||
        extracted.name === normalizedTarget ||
        extracted.name === bareTarget);
    if (!regexHit && !nameHit) continue;
    const name = extracted?.name || `line ${i + 1}`;
    const type = extracted?.type || "";
    matches.push({ name, type, line: i + 1, idx: i, defined: extracted !== null });
  }

  if (matches.length === 0) return null;

  // Prefer real definitions (extractName hit) over leftover call-site regex hits
  const defined = matches.filter((m) => m.defined);
  const pool = defined.length > 0 ? defined : matches;

  // Prefer exact qualified / exact bare name when multiple defs share a suffix
  const exact = pool.filter(
    (m) =>
      m.name === target ||
      m.name === normalizedTarget ||
      m.name === bareTarget ||
      m.name.endsWith(`::${bareTarget ?? normalizedTarget}`) ||
      m.name.endsWith(`.${bareTarget ?? normalizedTarget}`)
  );
  let chosen = exact.length > 0 ? exact : pool;

  // class Foo vs constructor Foo — prefer the type declaration for bare type names
  if (chosen.length > 1) {
    const types = chosen.filter((m) =>
      /^(class|struct|interface|enum|record|enum class|namespace|union)$/i.test(m.type)
    );
    if (types.length === 1) chosen = types;
  }

  if (chosen.length > 1) {
    return {
      candidates: chosen.map((m) => ({
        name: m.type ? `${m.type} ${m.name}` : m.name,
        line: m.line,
      })),
    };
  }

  const defIdx = chosen[0].idx;
  // Decorators / attributes above the def — expand start, but block-end still keys off def
  const startIdx = handler.expandSectionStart
    ? handler.expandSectionStart(lines, defIdx)
    : defIdx;

  const detectedEnd = handler.findBlockEnd ? handler.findBlockEnd(lines, defIdx) : null;
  let blockEndDetected = false;
  let blockTruncated = false;
  let totalBlockLines: number | undefined;

  let endIdx: number;
  if (detectedEnd !== null) {
    blockEndDetected = true;
    totalBlockLines = detectedEnd - startIdx + 1;
    if (detectedEnd > startIdx + limit - 1) {
      endIdx = startIdx + limit - 1;
      blockTruncated = true;
    } else {
      endIdx = detectedEnd;
    }
  } else {
    endIdx = Math.min(lines.length - 1, startIdx + limit - 1);
  }

  return {
    lines: lines.slice(startIdx, endIdx + 1),
    startLine: startIdx + 1,
    endLine: endIdx + 1,
    blockEndDetected,
    blockTruncated,
    totalBlockLines,
  };
}

/** Include @decorators (and multi-line decorator args) above a Python def/class. */
function expandPythonDecoratorStart(lines: string[], defIdx: number): number {
  if (defIdx <= 0 || defIdx >= lines.length) return defIdx;
  const baseMatch = lines[defIdx].match(/^(\s*)/);
  const baseIndent = baseMatch ? baseMatch[1].length : 0;

  let firstAt = -1;
  // Scan upward a short window; stop at previous sibling at same indent.
  for (let i = defIdx - 1; i >= 0 && i >= defIdx - 30; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indentMatch = lines[i].match(/^(\s*)/);
    const ind = indentMatch ? indentMatch[1].length : 0;
    if (ind > baseIndent) {
      // Decorator argument continuation or previous body — keep scanning
      continue;
    }
    if (ind === baseIndent && trimmed.startsWith("@")) {
      firstAt = i;
      continue;
    }
    // Closing paren of multi-line decorator often sits at base indent
    if (ind === baseIndent && /^[)\]],?$/.test(trimmed)) {
      continue;
    }
    break;
  }
  return firstAt >= 0 ? firstAt : defIdx;
}

function findPythonBlockEnd(lines: string[], startIdx: number): number | null {
  if (startIdx >= lines.length) return null;
  const baseMatch = lines[startIdx].match(/^(\s*)/);
  const baseIndent = baseMatch ? baseMatch[1].length : 0;

  let lastContentLine = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;

    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    if (indent <= baseIndent) {
      return lastContentLine;
    }
    lastContentLine = i;
  }
  return lines.length - 1;
}

function findBraceBlockEnd(lines: string[], startIdx: number): number | null {
  let braceBalance = 0;
  let insideBlock = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    let inString: '"' | "'" | "`" | null = null;
    let escaped = false;
    let inLineComment = false;

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];

      if (inLineComment) continue;

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === inString) {
          inString = null;
        }
        continue;
      }

      if (ch === "/" && j + 1 < line.length && line[j + 1] === "/") {
        inLineComment = true;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        continue;
      }

      if (ch === "{") {
        braceBalance++;
        insideBlock = true;
      } else if (ch === "}") {
        if (!insideBlock) continue;
        braceBalance--;
        if (braceBalance === 0) {
          return i;
        }
      }
    }
  }

  return null;
}

function findCppBlockEnd(lines: string[], startIdx: number): number | null {
  let braceBalance = 0;
  let insideBlock = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    let inString: '"' | "'" | null = null;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const nextCh = j + 1 < line.length ? line[j + 1] : "";

      if (inLineComment) continue;

      if (inBlockComment) {
        if (ch === "*" && nextCh === "/") {
          inBlockComment = false;
          j++;
        }
        continue;
      }

      if (ch === "/" && nextCh === "/") {
        inLineComment = true;
        j++;
        continue;
      }

      if (ch === "/" && nextCh === "*") {
        inBlockComment = true;
        j++;
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === inString) {
          inString = null;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }

      if (ch === "{") {
        braceBalance++;
        insideBlock = true;
      } else if (ch === "}") {
        if (!insideBlock) continue;
        braceBalance--;
        if (braceBalance === 0) {
          return i;
        }
      }
    }
  }

  return null;
}

function findEndBlockEnd(lines: string[], startIdx: number): number | null {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^end\b/.test(trimmed)) {
      return i;
    }
  }
  return lines.length - 1;
}

export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0b11000000) === 0b10000000) {
    cut--;
  }
  return {
    text: buf.slice(0, cut).toString("utf-8") + "\n\n[Truncated: use mode:section or the separate grep tool to narrow down]",
    truncated: true,
  };
}
