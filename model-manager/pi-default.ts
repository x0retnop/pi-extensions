import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

/**
 * Pi's own startup model lives in `~/.pi/agent/settings.json` as
 * `defaultProvider` + `defaultModel`. Pi applies it when a new session starts,
 * before any extension loads (Pi's `/model` → Ctrl+S writes these same keys).
 *
 * `/mm` owns them from the UI side so the model manager is the single place to
 * manage models: the old `model-manager.json` → `global.defaultProvider` was a
 * *second* default that ran 2–3 s after Pi had already picked its own, which is
 * why a switch made in `/mm` never moved the startup model.
 */
export interface PiDefaultModel {
  provider: string;
  modelId: string;
}

function settingsPath(): string {
  return path.join(getAgentDir(), "settings.json");
}

export function readPiDefault(): PiDefaultModel | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf-8")) as {
      defaultProvider?: unknown;
      defaultModel?: unknown;
    };
    const provider = typeof parsed.defaultProvider === "string" ? parsed.defaultProvider : undefined;
    const modelId = typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined;
    return provider && modelId ? { provider, modelId } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write (or clear, with `undefined`) Pi's startup model.
 * Never rewrites a settings.json that exists but cannot be parsed — a blind
 * write would drop every other setting in the file.
 * @returns true if settings.json was written successfully
 */
export function writePiDefault(model: PiDefaultModel | undefined): boolean {
  const file = settingsPath();
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error(`[model-manager] Refusing to write ${file}: not a JSON object`);
        return false;
      }
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      console.error(`[model-manager] Refusing to write ${file}: ${err}`);
      return false;
    }
  }
  if (model) {
    settings.defaultProvider = model.provider;
    settings.defaultModel = model.modelId;
  } else {
    delete settings.defaultProvider;
    delete settings.defaultModel;
  }

  let tmp: string | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    try {
      fs.renameSync(tmp, file);
      tmp = undefined;
    } catch {
      // Fallback for cross-device or Windows lock races (Pi writes this file too).
      fs.copyFileSync(tmp, file);
      fs.unlinkSync(tmp);
      tmp = undefined;
    }
    return true;
  } catch (err) {
    console.error(`[model-manager] Failed to write Pi default model to ${file}: ${err}`);
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore cleanup failure
      }
    }
    return false;
  }
}
