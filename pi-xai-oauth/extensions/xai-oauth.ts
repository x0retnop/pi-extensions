import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getGrokAuthCredentials } from "./xai/auth";
import { XAI_API_BASE_URL, XAI_PROVIDER_ID } from "./xai/constants";
import { loadXaiConfig, saveXaiConfig } from "./xai/config";
import { MODELS } from "./xai/models";
import { createXaiOAuth } from "./xai/oauth";
import { streamSimpleXaiResponses } from "./xai/responses";
import { registerXaiTools } from "./xai/tools";
import { syncCursorToolShimsForModel } from "./xai/tools/cursor-shims";

let initDone = false;

function doInit(pi: ExtensionAPI) {
  if (initDone) return;
  initDone = true;

  pi.registerProvider(XAI_PROVIDER_ID, {
    name: "xAI (OAuth)",
    baseUrl: XAI_API_BASE_URL,
    api: "xai-responses",
    models: MODELS as any,
    authHeader: true,
    streamSimple: streamSimpleXaiResponses as any,
    oauth: createXaiOAuth({ getExistingCredentials: getGrokAuthCredentials }) as any,
  });

  registerXaiTools(pi);

  if (typeof (pi as any).on === "function") {
    (pi as any).on("session_start", (_event: any, ctx: any) => {
      if (ctx?.ui?.setStatus) ctx.ui.setStatus("xai", "xai: on");
      syncCursorToolShimsForModel(ctx, ctx?.model);
    });
    (pi as any).on("model_select", (event: any, ctx: any) => {
      syncCursorToolShimsForModel(ctx, event?.model);
    });
    (pi as any).on("before_agent_start", (_event: any, ctx: any) => {
      if (ctx?.ui?.setStatus) ctx.ui.setStatus("xai", "xai: on");
      syncCursorToolShimsForModel(ctx, ctx?.model);
    });
  }
}

export default function (pi: ExtensionAPI) {
  // Toggle command is always registered so the user can turn the extension on/off
  pi.registerCommand("xai", {
    description: "Toggle the xAI OAuth extension on or off",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const state = args.trim().toLowerCase();
      if (state !== "on" && state !== "off") {
        ctx.ui?.notify?.("Usage: /xai on  or  /xai off", "warning");
        return;
      }
      const enabled = state === "on";
      saveXaiConfig({ enabled });
      ctx.ui?.notify?.(`xAI OAuth extension set to ${enabled ? "ON" : "OFF"}. Restart Pi to apply.`, "info");
    },
  });

  const cfg = loadXaiConfig();
  if (cfg.enabled) {
    doInit(pi);
  }
}
