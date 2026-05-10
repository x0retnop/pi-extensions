import type { CompoundPart, Redirect, Segment } from "./types.js";

const WHITESPACE = /\s/;

function splitByOperator(
  command: string,
  operators: string[]
): { parts: string[]; ops: Array<string | undefined> } {
  const parts: string[] = [];
  const ops: Array<string | undefined> = [];
  let current = "";
  let state: "normal" | "single" | "double" = "normal";

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (state === "single") {
      if (ch === "'") state = "normal";
      current += ch;
      continue;
    }

    if (state === "double") {
      if (ch === "\\" && i + 1 < command.length) {
        current += ch + next;
        i++;
        continue;
      }
      if (ch === '"') state = "normal";
      current += ch;
      continue;
    }

    if (ch === "\\" && i + 1 < command.length) {
      current += ch + next;
      i++;
      continue;
    }

    if (ch === "'") {
      state = "single";
      current += ch;
      continue;
    }

    if (ch === '"') {
      state = "double";
      current += ch;
      continue;
    }

    let matchedOp: string | undefined;
    for (const op of operators) {
      if (op.length === 1) {
        if (ch === op) {
          matchedOp = op;
          break;
        }
      } else if (op.length === 2) {
        if (ch === op[0] && next === op[1]) {
          matchedOp = op;
          break;
        }
      }
    }

    if (matchedOp) {
      const trimmed = current.trim();
      if (trimmed) {
        parts.push(trimmed);
        ops.push(parts.length === 1 ? undefined : matchedOp);
      }
      current = "";
      if (matchedOp.length === 2) i++;
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) {
    parts.push(trimmed);
    ops.push(parts.length === 1 ? undefined : undefined);
  }

  return { parts, ops };
}

export function tokenize(command: string): CompoundPart[] {
  const { parts, ops } = splitByOperator(command, ["&&", "||", ";"]);

  const result: CompoundPart[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const op = ops[i];

    const pipeParts = splitByOperator(part, ["|"]);
    const segments: Segment[] = [];
    for (let j = 0; j < pipeParts.parts.length; j++) {
      const seg = parseSegment(pipeParts.parts[j]);
      if (seg.argv.length > 0) {
        segments.push(seg);
      }
    }

    result.push({
      operator: op as "&&" | "||" | ";" | undefined,
      pipeline: { segments },
    });
  }

  return result;
}

function parseSegment(raw: string): Segment {
  const tokens = tokenizeArgv(raw);
  const { argv, redirects } = extractRedirects(tokens);
  return { raw, argv, redirects };
}

function tokenizeArgv(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let state: "normal" | "single" | "double" = "normal";

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (state === "single") {
      if (ch === "'") {
        state = "normal";
      }
      current += ch;
      continue;
    }

    if (state === "double") {
      if (ch === "\\" && next) {
        current += ch + next;
        i++;
        continue;
      }
      if (ch === '"') {
        state = "normal";
      }
      current += ch;
      continue;
    }

    if (ch === "\\" && next) {
      current += ch + next;
      i++;
      continue;
    }

    if (ch === "'") {
      state = "single";
      current += ch;
      continue;
    }

    if (ch === '"') {
      state = "double";
      current += ch;
      continue;
    }

    if (WHITESPACE.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

const REDIRECT_PREFIXES: Array<{ prefix: string; type: Redirect["type"] }> = [
  { prefix: ">>", type: ">>" },
  { prefix: ">\u0026", type: ">\u0026" },
  { prefix: "<\u0026", type: "<\u0026" },
  { prefix: "2>>", type: "2>>" },
  { prefix: "2>", type: "2>" },
  { prefix: "1>>", type: "1>>" },
  { prefix: "1>", type: "1>" },
  { prefix: "<", type: "<" },
  { prefix: ">", type: ">" },
];

function extractRedirects(tokens: string[]): { argv: string[]; redirects: Redirect[] } {
  const argv: string[] = [];
  const redirects: Redirect[] = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];
    let matched = false;

    for (const { prefix, type } of REDIRECT_PREFIXES) {
      if (tok === prefix) {
        redirects.push({ type, target: tokens[i + 1] || "" });
        i += 2;
        matched = true;
        break;
      }
      if (tok.startsWith(prefix)) {
        redirects.push({ type, target: tok.slice(prefix.length) });
        i += 1;
        matched = true;
        break;
      }
    }

    if (!matched) {
      argv.push(tok);
      i++;
    }
  }

  return { argv, redirects };
}
