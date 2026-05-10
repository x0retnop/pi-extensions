// ─── Permission Gate Types ───

export type GateMode = "strict" | "balanced" | "relaxed" | "yolo";

export type Risk = "read" | "write" | "delete" | "execute" | "network" | "install" | "destructive";

export type Category = Risk | "unknown";

export type Effect = "none" | "escalate" | "reduce" | "suppressConfirm";

export interface FlagMeta {
  effect: Effect;
  description?: string;
  toRisk?: Risk;
  addCategories?: Category[];
}

export interface SubcommandMeta {
  risk: Risk;
  categories: Category[];
  description?: string;
  autoAllowModes?: GateMode[];
  flags?: Record<string, FlagMeta>;
}

export interface CommandMeta {
  description?: string;
  defaultRisk: Risk;
  defaultCategories: Category[];
  subcommands?: Record<string, SubcommandMeta>;
  commonFlags?: Record<string, FlagMeta>;
  aliases?: string[];
  notes?: string;
}

export interface CommandDB {
  [command: string]: CommandMeta;
}

export interface Redirect {
  type: ">" | ">>" | "<" | ">&" | "<&" | "2>" | "2>>" | "1>" | "1>>";
  target: string;
}

export interface Segment {
  raw: string;
  argv: string[];
  redirects: Redirect[];
}

export interface Pipeline {
  segments: Segment[];
}

export interface CompoundPart {
  operator?: "&&" | "||" | ";";
  pipeline: Pipeline;
}

export interface AnalyzedSegment {
  commandName: string;
  originalName: string;
  subcommand?: string;
  flags: string[];
  redirects: Redirect[];
  risk: Risk | "unknown";
  categories: Category[];
  autoAllowModes: GateMode[];
  reason: string;
}

export interface AnalyzedPipeline {
  segments: AnalyzedSegment[];
  risk: Risk | "unknown";
  categories: Category[];
}

export interface AnalyzedCommand {
  parts: AnalyzedPipeline[];
  operators: Array<"&&" | "||" | ";">;
  risk: Risk | "unknown";
  categories: Category[];
  isCompound: boolean;
  isPipeline: boolean;
}

export type DecisionAction = "allow" | "ask" | "block";

export interface Decision {
  action: DecisionAction;
  reason?: string;
}
