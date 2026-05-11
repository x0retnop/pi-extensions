// @ts-nocheck

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");

function loadModelsJson(): any {
  try {
    if (existsSync(MODELS_JSON_PATH)) {
      return JSON.parse(readFileSync(MODELS_JSON_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function findProviderConfig(modelsJson: any, model: any): any | undefined {
  if (!model || !modelsJson.providers) return undefined;

  const providers = modelsJson.providers;
  for (const [key, config] of Object.entries(providers)) {
    const p = config as any;
    // Match by baseUrl + api type
    if (p.baseUrl === model.baseUrl && p.api === model.api) {
      return { key, ...p };
    }
    // Or match by model id in the models list
    if (p.models && Array.isArray(p.models)) {
      for (const m of p.models) {
        if (m.id === model.id) {
          return { key, ...p };
        }
      }
    }
  }
  return undefined;
}

let currentTemp: number | undefined = undefined;

function getApiType(model: any): string {
  return model?.api || "unknown";
}

function isKimiProvider(model: any): boolean {
  const apiType = getApiType(model);
  const baseUrl = model?.baseUrl || "";
  return apiType === "anthropic-messages" && baseUrl.includes("kimi.com");
}

function showStatus(ctx: any, providerConfig?: any) {
  if (ctx?.ui?.setStatus) {
    const model = ctx.model;
    const providerName = providerConfig?.name || model?.provider || "unknown";

    if (isKimiProvider(model)) {
      ctx.ui.setStatus("tm", `        tm: locked (${providerName})`);
      return;
    }

    const temp = currentTemp !== undefined ? currentTemp.toFixed(1) : "default";
    ctx.ui.setStatus("tm", `        tm: ${temp} (${providerName})`);
  }
}

export default function (pi: any) {
  const modelsJson = loadModelsJson();

  pi.on("session_start", async (_event: any, ctx: any) => {
    const model = ctx.model;
    const providerConfig = findProviderConfig(modelsJson, model);

    // Use default temperature from models.json if set
    if (providerConfig && typeof providerConfig.temperature === "number") {
      currentTemp = providerConfig.temperature;
    }

    showStatus(ctx, providerConfig);
  });

  pi.on("model_select", async (event: any, ctx: any) => {
    const model = event.model || ctx.model;
    const providerConfig = findProviderConfig(modelsJson, model);

    if (providerConfig && typeof providerConfig.temperature === "number") {
      currentTemp = providerConfig.temperature;
    }

    showStatus(ctx, providerConfig);
  });

  pi.registerCommand("tm", {
    description: "Set temperature for LLM requests (e.g., /tm 0.7). Use /tm to check current value.",
    handler: async (args: string, ctx: any) => {
      const model = ctx.model;
      const providerConfig = findProviderConfig(modelsJson, model);

      if (isKimiProvider(model)) {
        ctx.ui.notify?.("Kimi models use fixed sampling parameters. Temperature cannot be changed.", "warning");
        return;
      }

      const value = args.trim();

      if (!value) {
        const temp = currentTemp !== undefined ? currentTemp.toFixed(1) : "default (provider)";
        ctx.ui.notify?.(`Current temperature: ${temp}`, "info");
        return;
      }

      const num = parseFloat(value);
      if (isNaN(num) || num < 0 || num > 2) {
        ctx.ui.notify?.(`Invalid temperature: ${value}. Use a number between 0 and 2.`, "error");
        return;
      }

      currentTemp = num;
      showStatus(ctx, providerConfig);
      ctx.ui.notify?.(`Temperature set to: ${num.toFixed(1)}`, "success");
    },
  });

  pi.on("before_provider_request", (event: any, ctx: any) => {
    const model = ctx.model;
    if (!model) return;

    const payload = event.payload as Record<string, unknown>;

    // Kimi uses fixed sampling parameters; injecting arbitrary values may error or be ignored
    if (isKimiProvider(model)) {
      delete payload.temperature;
      delete payload.top_p;
      delete payload.presence_penalty;
      delete payload.frequency_penalty;
      return payload;
    }

    if (currentTemp === undefined) return;

    const apiType = getApiType(model);
    const supportedApis = ["anthropic-messages", "openai-completions", "openai-responses"];
    if (supportedApis.includes(apiType)) {
      payload.temperature = currentTemp;
    }

    return payload;
  });
}
