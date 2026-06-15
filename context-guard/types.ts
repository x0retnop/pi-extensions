import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type FeatureCategory = "prompt" | "tools" | "skills";

export interface PromptRule {
  /** Textual id, also used as CLI argument to /ctx-guard <id>. */
  id: string;
  /** Human readable label shown in the TUI and /ctx-inspect. */
  label: string;
  /** Detailed explanation shown in the TUI. */
  description?: string;
  /** Default value for the ON state. true means the layer is kept by default. */
  defaultEnabled: boolean;
  /** Function that removes/injects the layer depending on enabled state. */
  apply: (prompt: string, opts: PromptRuleContext, enabled: boolean) => string;
}

export interface ToolGate {
  id: string;
  label: string;
  description?: string;
  defaultEnabled: boolean;
  /** Tools that should be active when the gate is enabled. */
  toolsOn?: string[];
  /** Tools that should be active when the gate is disabled. */
  toolsOff?: string[];
}

export interface SkillFeature {
  id: string;
  label: string;
  description?: string;
  /** Whether skills are auto-injected into the system prompt by default. */
  defaultEnabled: boolean;
}

export interface ManagedFeature {
  id: string;
  category: FeatureCategory;
  label: string;
  description?: string;
  defaultEnabled: boolean;
  /** For prompt rules only. */
  rule?: PromptRule;
  /** For tool gates only. */
  gate?: ToolGate;
  /** For skills feature only. */
  skill?: SkillFeature;
}

export interface PromptRuleContext {
  cwd?: string;
  options?: any;
  entries?: any[];
}

export interface GuardSettings {
  features: Record<string, boolean>;
  promptRules: Record<string, boolean>;
  autoSkills: boolean;
}

export interface GuardState {
  settings: GuardSettings;
  pi: ExtensionAPI;
}
