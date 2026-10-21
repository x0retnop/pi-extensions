import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ScopeCtx = ExtensionContext | ExtensionCommandContext;

type ScopedEntry = {
  model: Model<Api>;
  thinkingLevel?: string;
};

function readScoped(ctx: ScopeCtx): readonly ScopedEntry[] | undefined {
  const scoped = (ctx as { scopedModels?: readonly ScopedEntry[] }).scopedModels;
  return Array.isArray(scoped) ? scoped : undefined;
}

/** True when the session has a non-empty model scope (`--models` / `enabledModels`). */
export function hasModelScope(ctx: ScopeCtx): boolean {
  const scoped = readScoped(ctx);
  return Array.isArray(scoped) && scoped.length > 0;
}

/** Empty scope means every model is usable. */
export function isModelInScope(ctx: ScopeCtx, providerId: string, modelId: string): boolean {
  const scoped = readScoped(ctx);
  if (!scoped || scoped.length === 0) return true;
  return scoped.some((s) => s.model.provider === providerId && s.model.id === modelId);
}

/** Thinking level pinned by a scope pattern (e.g. `anthropic/*:high`), if any. */
export function findScopedThinkingLevel(
  ctx: ScopeCtx,
  providerId: string,
  modelId: string,
): string | undefined {
  const scoped = readScoped(ctx);
  if (!scoped || scoped.length === 0) return undefined;
  return scoped.find((s) => s.model.provider === providerId && s.model.id === modelId)?.thinkingLevel;
}

/** One-line UI summary, or undefined when no session scope is active. */
export function describeModelScope(ctx: ScopeCtx): string | undefined {
  const scoped = readScoped(ctx);
  if (!scoped || scoped.length === 0) return undefined;
  return `${scoped.length} model${scoped.length === 1 ? "" : "s"} in session scope`;
}
