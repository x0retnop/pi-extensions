import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface CompressorSettings {
  enabled: boolean;
  promptName: string;
  mode: "auto" | "manual";
  tokenThresholdPercent: number;
  stepInterval: number;
  minMessagesToSummarize: number;
  maxSummaryTokens: number;
  trimAfterCompress: boolean;
  keptRecentMessages: number;
  debug: boolean;
}

export const DEFAULT_SETTINGS: CompressorSettings = {
  enabled: true,
  promptName: "balanced",
  mode: "auto",
  tokenThresholdPercent: 55,
  stepInterval: 10,
  minMessagesToSummarize: 6,
  maxSummaryTokens: 2000,
  trimAfterCompress: false,
  keptRecentMessages: 8,
  debug: false,
};

export interface CompressorState {
  keyFacts: string | null;
  stepCounter: number;
  lastCompressionStep: number;
  lastCompressionEntryCount: number;
  lastCompressionAt: number | null;
  isCompressing: boolean;
  consecutiveFailures: number;
}

export function createState(): CompressorState {
  return {
    keyFacts: null,
    stepCounter: 0,
    lastCompressionStep: 0,
    lastCompressionEntryCount: 0,
    lastCompressionAt: null,
    isCompressing: false,
    consecutiveFailures: 0,
  };
}

export interface CompressorTUIDeps {
  settings: CompressorSettings;
  saveSettings: (s: CompressorSettings) => void;
  state: CompressorState;
  forceSummary: (ctx: ExtensionContext) => Promise<void>;
  listPrompts: () => string[];
}
