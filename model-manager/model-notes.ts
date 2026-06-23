import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

export interface ModelNotes {
  byProvider: Map<string, Map<string, string>>;
  byModelId: Map<string, string>;
}

export function loadModelNotes(): ModelNotes {
  const modelsJsonPath = path.join(getAgentDir(), "models.json");
  const empty: ModelNotes = { byProvider: new Map(), byModelId: new Map() };
  if (!fs.existsSync(modelsJsonPath)) {
    return empty;
  }
  try {
    const raw = fs.readFileSync(modelsJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, { models?: Array<{ id?: string; note?: string }> }>;
    };
    const byProvider = new Map<string, Map<string, string>>();
    const byModelId = new Map<string, string>();
    for (const [providerId, provider] of Object.entries(parsed.providers ?? {})) {
      const providerNotes = new Map<string, string>();
      for (const model of provider.models ?? []) {
        if (model.id && model.note) {
          providerNotes.set(model.id, model.note);
          // Keep a global fallback; if several providers share a model id the
          // provider-specific lookup wins.
          if (!byModelId.has(model.id)) {
            byModelId.set(model.id, model.note);
          }
        }
      }
      if (providerNotes.size > 0) {
        byProvider.set(providerId, providerNotes);
      }
    }
    return { byProvider, byModelId };
  } catch {
    return empty;
  }
}

export function getModelNote(notes: ModelNotes, providerId: string, modelId: string): string | undefined {
  return notes.byProvider.get(providerId)?.get(modelId) ?? notes.byModelId.get(modelId);
}
