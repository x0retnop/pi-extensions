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
}

export interface PromptRuleContext {
  cwd?: string;
  options?: any;
  entries?: any[];
}

/** Context pressure notices (60%/70% one-shot user-shaped nudges). */
export interface ContextNoticesSettings {
  /** Master switch. Default false. */
  enabled: boolean;
  /** Fire notice-60.md when context >= 60%. Default true. */
  notice60: boolean;
  /** Fire notice-70.md when context >= 70%. Default true. */
  notice70: boolean;
}

export interface GuardSettings {
  features: Record<string, boolean>;
  promptRules: Record<string, boolean>;
  autoSkills: boolean;
  /** Inject cwd/AGENTS.md as the first hidden custom message on an empty session. */
  agentsInject: boolean;
  contextNotices: ContextNoticesSettings;
}

export const DEFAULT_CONTEXT_NOTICES: ContextNoticesSettings = {
  enabled: false,
  notice60: true,
  notice70: true,
};
