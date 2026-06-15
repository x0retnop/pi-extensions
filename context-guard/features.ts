import type { ManagedFeature } from "./types.js";
import { PROMPT_RULES } from "./prompt-rules.js";
import { TOOL_GATES } from "./tool-gates.js";

export const SKILL_FEATURE: ManagedFeature = {
  id: "autoSkills",
  category: "skills",
  label: "Automatic skill injection",
  description: "Inject available skills block into the system prompt.",
  defaultEnabled: true,
};

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

export function getFeatureIds(): string[] {
  return MANAGED_FEATURES.map((f) => f.id);
}

export function getDefaultSettings(): { features: Record<string, boolean>; promptRules: Record<string, boolean>; autoSkills: boolean } {
  return {
    promptRules: Object.fromEntries(PROMPT_RULES.map((r) => [r.id, r.defaultEnabled])),
    features: Object.fromEntries(TOOL_GATES.map((g) => [g.id, g.defaultEnabled])),
    autoSkills: SKILL_FEATURE.defaultEnabled,
  };
}
