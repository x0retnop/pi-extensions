import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

export type ModelNoteMap = Map<string, Map<string, string>>;

export function loadModelNotes(): ModelNoteMap {
  const modelsJsonPath = path.join(getAgentDir(), "models.json");
  if (!fs.existsSync(modelsJsonPath)) {
    return new Map();
  }
  try {
    const raw = fs.readFileSync(modelsJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, { models?: Array<{ id?: string; note?: string }> }>;
    };
    const result = new Map<string, Map<string, string>>();
    for (const [providerId, provider] of Object.entries(parsed.providers ?? {})) {
      const providerNotes = new Map<string, string>();
      for (const model of provider.models ?? []) {
        if (model.id && model.note) {
          providerNotes.set(model.id, model.note);
        }
      }
      if (providerNotes.size > 0) {
        result.set(providerId, providerNotes);
      }
    }
    return result;
  } catch {
    return new Map();
  }
}
