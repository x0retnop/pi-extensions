/**
 * Hide the xAI Grok 4.5+ *visible* thinking summary in the TUI.
 *
 * Two independent checks (AND). Do not collapse them into one regex.
 *
 * 1. Model family — `id` or `name` after whitespace→`-`.
 *    `^grok-4.(\d+)(?:-[a-z0-9.-]+)?$` and minor >= 5.
 *    Hits: grok-4.5, grok-4.6, grok-4.20-multi-agent, spaced labels like
 *    `grok 4.6 f` (former host picker name; same SKU).
 *    Misses: grok-4.3, grok-build-0.1, grok-3, `grok-4.6f` (no separator).
 *
 * 2. Transport — provider id OR baseUrl. Same SKU on a random proxy is not
 *    automatically xAI.
 *    Hits: provider `xai`; `opencode` / `opencode-go` (same Responses replay);
 *    baseUrl contains `api.x.ai` or `cli-chat-proxy.grok.com`.
 *    Misses: openrouter / custom clones unless their baseUrl is xAI.
 *
 * Display only (`registerMarkdownTransformer` on assistant-thinking).
 * Does not touch encrypted replay, effort, or `/thinking off`.
 */

export interface GrokThinkModelRef {
  provider: string;
  id: string;
  name?: string;
  baseUrl?: string;
}

export const GROK_THINK_HIDDEN_LABEL = "Thinking...";

const XAI_PROVIDERS = new Set(["xai"]);
const XAI_PROXY_PROVIDERS = new Set(["opencode", "opencode-go"]);

export function toGrokThinkRef(
  model: { provider?: string; id?: string; name?: string; baseUrl?: string } | undefined,
): GrokThinkModelRef | undefined {
  if (!model?.provider || !model.id) return undefined;
  return { provider: model.provider, id: model.id, name: model.name, baseUrl: model.baseUrl };
}

/** grok-4.N minor from an id or display label, or null. */
export function grokFamilyMinor(label: string): number | null {
  // "grok 4.6 f" / "grok-4.6 f" → grok-4.6-f (spaced display names, same SKU).
  const n = label.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  const m = n.match(/^grok-4\.(\d+)(?:-[a-z0-9.-]+)?$/);
  if (!m) return null;
  return Number(m[1]);
}

export function isGrok45PlusId(modelId: string): boolean {
  const minor = grokFamilyMinor(modelId);
  return minor !== null && minor >= 5;
}

export function isXaiGrokTransport(provider: string, baseUrl?: string): boolean {
  const p = provider.trim().toLowerCase();
  if (XAI_PROVIDERS.has(p) || XAI_PROXY_PROVIDERS.has(p)) return true;
  const url = (baseUrl ?? "").toLowerCase();
  return url.includes("api.x.ai") || url.includes("cli-chat-proxy.grok.com");
}

function grokFamilyMinorOf(model: GrokThinkModelRef): number | null {
  return grokFamilyMinor(model.id) ?? (model.name ? grokFamilyMinor(model.name) : null);
}

export function isGrokSummaryModel(model: GrokThinkModelRef | undefined): boolean {
  if (!model) return false;
  const minor = grokFamilyMinorOf(model);
  return minor !== null && minor >= 5 && isXaiGrokTransport(model.provider, model.baseUrl);
}

export function shouldHideGrokThinking(
  model: GrokThinkModelRef | undefined,
  hideEnabled: boolean,
): boolean {
  return hideEnabled && isGrokSummaryModel(model);
}

export function grokThinkMatchReason(model: GrokThinkModelRef | undefined): string {
  if (!model) return "no current model";
  const key = model.name && grokFamilyMinor(model.id) === null ? `${model.id} (${model.name})` : model.id;
  const minor = grokFamilyMinorOf(model);
  if (minor === null) return `${model.provider}::${key} — not grok-4.N`;
  if (minor < 5) return `${model.provider}::${key} — grok-4.${minor} has no encrypted-summary panel`;
  if (!isXaiGrokTransport(model.provider, model.baseUrl)) {
    return `${model.provider}::${key} — grok-4.${minor} but transport is not xAI`;
  }
  return `${model.provider}::${key} — grok-4.${minor} on xAI transport`;
}

export function transformGrokThinkingMarkdown(
  markdown: string,
  messageType: string,
  model: GrokThinkModelRef | undefined,
  hideEnabled: boolean,
): string {
  if (messageType !== "assistant-thinking") return markdown;
  if (!shouldHideGrokThinking(model, hideEnabled)) return markdown;
  return GROK_THINK_HIDDEN_LABEL;
}

export function grokThinkCommandStatus(
  hideEnabled: boolean,
  model: GrokThinkModelRef | undefined,
): string {
  const mode = hideEnabled ? "hidden" : "shown";
  const active = shouldHideGrokThinking(model, hideEnabled) ? "active" : "idle";
  return `Grok thinking summary: ${mode} (${active}). ${grokThinkMatchReason(model)}`;
}
