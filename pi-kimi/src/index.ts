// Minimal Kimi For Coding provider for Pi.
// Registers "kimi-for-coding" with OAuth device flow and Kimi-CLI headers.
// Relies on Pi's built-in openai-completions streaming.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { loginWithDeviceFlow, refreshKimiCredentials } from "./oauth.js"
import { kimiHeaders } from "./headers.js"

export default function (pi: ExtensionAPI) {
  const baseUrl = "https://api.kimi.com/coding/v1"

  pi.registerProvider("kimi-for-coding", {
    baseUrl,
    api: "openai-completions",
    models: [
      {
        id: "kimi-for-coding",
        name: "Kimi For Coding",
        api: "openai-completions",
        baseUrl,
        reasoning: true,
        input: ["text", "image"],
        cost: {
          input: 0.95,
          output: 4,
          cacheRead: 0.16,
          cacheWrite: 0,
        },
        contextWindow: 262_144,
        maxTokens: 32_768,
        headers: kimiHeaders(),
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "high",
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          thinkingFormat: "openai",
        },
      },
    ],
    oauth: {
      name: "Kimi For Coding",
      login: loginWithDeviceFlow,
      refreshToken: refreshKimiCredentials,
      getApiKey: (credentials) => credentials.access,
    },
  })
}
