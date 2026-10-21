import type { ManagedFeature } from "./types.js";
import { PROMPT_RULES } from "./prompt-rules.js";
import { TOOL_GATES } from "./tool-gates.js";

export const SKILL_FEATURE: ManagedFeature = {
  id: "autoSkills",
  category: "skills",
  label: "Auto-inject skill list",
  description: "Inject the available-skills block into the system prompt.",
  defaultEnabled: true,
};

/** Short labels for boot banner (scan in ≤2s). Full TUI labels live on ManagedFeature.label. */
export const FEATURE_SHORT_LABEL: Record<string, string> = {
  date: "date",
  cwd: "workdir",
  agents: "agents.md",
  ancestorAgents: "ancestors",
  piDocs: "pi-docs",
  toolSnippets: "tool list",
  roleOverride: "role text",
  bash: "bash",
  autoSkills: "auto-skills",
  agentsInject: "agents-msg",
};

export function shortLabel(id: string): string {
  return FEATURE_SHORT_LABEL[id] ?? id;
}

export const MANAGED_FEATURES: ManagedFeature[] = [
  ...PROMPT_RULES.map((rule) => ({
    id: rule.id,
    category: "prompt" as const,
    label: rule.label,
    description: rule.description,
    defaultEnabled: rule.defaultEnabled,
    rule,
  })),
  SKILL_FEATURE,
  ...TOOL_GATES.map((gate) => ({
    id: gate.id,
    category: "tools" as const,
    label: gate.label,
    description: gate.description,
    defaultEnabled: gate.defaultEnabled,
    gate,
  })),
];

export function getFeatureById(id: string): ManagedFeature | undefined {
  return MANAGED_FEATURES.find((f) => f.id === id);
}
