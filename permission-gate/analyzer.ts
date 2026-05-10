import type {
  Segment,
  AnalyzedSegment,
  AnalyzedPipeline,
  AnalyzedCommand,
  CompoundPart,
  Risk,
  Category,
  GateMode,
} from "./types.js";
import {
  loadCommandDB,
  resolveCommand,
  getMeta,
  resolveFlagEffect,
  maxRisk,
  mergeCategories,
  isAutoAllowed,
} from "./command-db.js";

const db = loadCommandDB();

export function analyzeSegment(seg: Segment): AnalyzedSegment {
  if (seg.argv.length === 0) {
    return {
      commandName: "",
      originalName: "",
      flags: [],
      redirects: seg.redirects,
      risk: "read",
      categories: ["read"],
      autoAllowModes: [],
      reason: "empty command",
      subcommand: undefined,
    };
  }

  const originalName = seg.argv[0];
  const canonical = resolveCommand(originalName, db);
  const meta = canonical ? getMeta(db, canonical) : undefined;

  if (!meta) {
    const knownShells = new Set(["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh", "csh", "ksh"]);
    if (knownShells.has(originalName.toLowerCase())) {
      return {
        commandName: originalName.toLowerCase(),
        originalName,
        flags: seg.argv.slice(1).filter((a) => a.startsWith("-")),
        redirects: seg.redirects,
        risk: "execute",
        categories: applyRedirects(["execute"], seg.redirects),
        autoAllowModes: [],
        reason: "shell execution",
        subcommand: undefined,
      };
    }
    const risk: Risk | "unknown" = "unknown";
    const cats: Category[] = ["unknown"];
    return {
      commandName: originalName.toLowerCase(),
      originalName,
      flags: seg.argv.slice(1).filter((a) => a.startsWith("-")),
      redirects: seg.redirects,
      risk,
      categories: applyRedirects(cats, seg.redirects),
      autoAllowModes: [],
      reason: "unknown command",
      subcommand: undefined,
    };
  }

  // Find subcommand
  let subcommand: string | undefined;
  const remaining: string[] = [];
  const subcmdKeys = meta.subcommands ? Object.keys(meta.subcommands) : [];

  // First pass: exact token match (includes flags like -c, -m)
  for (let i = 1; i < seg.argv.length; i++) {
    const tok = seg.argv[i];
    if (subcmdKeys.includes(tok)) {
      subcommand = tok;
      remaining.push(...seg.argv.slice(i + 1));
      break;
    }
  }

  // Second pass: first non-flag token that matches a subcommand key
  if (!subcommand) {
    for (let i = 1; i < seg.argv.length; i++) {
      const tok = seg.argv[i];
      if (!tok.startsWith("-") && subcmdKeys.includes(tok)) {
        subcommand = tok;
        remaining.push(...seg.argv.slice(i + 1));
        break;
      }
      remaining.push(tok);
    }
  }

  if (!subcommand) {
    remaining.push(...seg.argv.slice(1));
  }

  const flags = remaining.filter((a) => a.startsWith("-"));

  const subMeta = subcommand ? meta.subcommands![subcommand] : undefined;
  let risk: Risk = subMeta?.risk ?? meta.defaultRisk;
  let categories: Category[] = [...(subMeta?.categories ?? meta.defaultCategories)];
  let autoAllowModes: GateMode[] = subMeta?.autoAllowModes ? [...subMeta.autoAllowModes] : [];

  // Apply flags
  let sawEscalate = false;
  for (const flag of flags) {
    const fm = resolveFlagEffect(flag, meta, subcommand);
    if (!fm) continue;
    if (fm.effect === "escalate") {
      sawEscalate = true;
      if (fm.toRisk) risk = maxRisk(risk, fm.toRisk) as Risk;
      if (fm.addCategories) categories = mergeCategories(categories, fm.addCategories);
    } else if (fm.effect === "reduce") {
      if (!sawEscalate && fm.toRisk) {
        risk = fm.toRisk;
      }
    }
  }

  // Command substitution / backtick heuristic
  if (hasCommandSubstitution(seg.raw)) {
    risk = maxRisk(risk, "execute") as Risk;
    if (!categories.includes("execute")) categories.push("execute");
  }

  // Apply redirects
  categories = applyRedirects(categories, seg.redirects);
  for (const red of seg.redirects) {
    if (red.type === ">" || red.type === ">>" || red.type.startsWith("1") || red.type.startsWith("2")) {
      risk = maxRisk(risk, "write") as Risk;
      if (!categories.includes("write")) categories.push("write");
    }
    if (red.type === "<") {
      if (!categories.includes("read")) categories.push("read");
    }
  }

  const reason = subcommand
    ? `${canonical} ${subcommand} → ${risk}`
    : `${canonical} → ${risk}`;

  return {
    commandName: canonical,
    originalName,
    subcommand,
    flags,
    redirects: seg.redirects,
    risk,
    categories,
    autoAllowModes,
    reason,
  };
}

function applyRedirects(cats: Category[], redirects: Segment["redirects"]): Category[] {
  const out = [...cats];
  for (const red of redirects) {
    if (red.type === ">" || red.type === ">>" || red.type.startsWith("1") || red.type.startsWith("2")) {
      if (!out.includes("write")) out.push("write");
    }
    if (red.type === "<") {
      if (!out.includes("read")) out.push("read");
    }
  }
  return out;
}

function hasCommandSubstitution(raw: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === "`") return true;
      if (ch === "$" && next === "(") return true;
    }
  }
  return false;
}

export function analyzePipeline(pipeline: { segments: Segment[] }): AnalyzedPipeline {
  const segments = pipeline.segments.map(analyzeSegment);
  let risk: Risk | "unknown" = "read";
  let categories: Category[] = [];
  let hasNetwork = false;
  let hasExecute = false;
  let hasDestructive = false;

  for (const seg of segments) {
    risk = maxRisk(risk, seg.risk);
    categories = mergeCategories(categories, seg.categories);
    if (seg.categories.includes("network")) hasNetwork = true;
    if (seg.categories.includes("execute")) hasExecute = true;
    if (seg.categories.includes("destructive")) hasDestructive = true;
  }

  // Pipeline heuristic: if one segment is network and another is execute/destructive
  // treat as destructive (e.g. curl ... | sh)
  if (segments.length > 1) {
    const netIdx = segments.findIndex((s) => s.categories.includes("network"));
    const execIdx = segments.findIndex((s) => s.categories.includes("execute") || s.categories.includes("destructive"));
    if (netIdx !== -1 && execIdx !== -1 && netIdx !== execIdx) {
      risk = "destructive";
      if (!categories.includes("destructive")) categories.push("destructive");
    }
  }

  return { segments, risk, categories };
}

export function analyzeCommand(parts: CompoundPart[]): AnalyzedCommand {
  const analyzedParts = parts.map((p) => analyzePipeline(p.pipeline));
  let risk: Risk | "unknown" = "read";
  let categories: Category[] = [];

  for (const part of analyzedParts) {
    risk = maxRisk(risk, part.risk);
    categories = mergeCategories(categories, part.categories);
  }

  return {
    parts: analyzedParts,
    operators: parts.map((p) => p.operator).filter((op): op is "&&" | "||" | ";" => !!op),
    risk,
    categories,
    isCompound: parts.length > 1,
    isPipeline: analyzedParts.some((p) => p.segments.length > 1),
  };
}
