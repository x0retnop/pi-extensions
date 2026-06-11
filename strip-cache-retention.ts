import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as Record<string, any>;
    if (!payload || typeof payload !== "object") return;

    if ("prompt_cache_retention" in payload) {
      delete payload.prompt_cache_retention;
    }

    if (typeof payload.model === "string" && payload.model.includes("{{")) {
      const rawId = event.model?.id;
      if (rawId) {
        payload.model = rawId.includes("/") ? rawId.split("/").pop() : rawId;
      }
    }

    return payload;
  });
}