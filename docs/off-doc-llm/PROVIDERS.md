# Providers

> Subscription (OAuth) or API-key based. Models updated with each release.
> Custom providers/models via `~/.pi/agent/models.json` or `pi.registerProvider()`.

---

## Subscription providers (`/login`)

| Provider | Auth type |
|----------|-----------|
| ChatGPT Plus/Pro (Codex) | OAuth |
| Claude Pro/Max | OAuth |
| GitHub Copilot | OAuth |

Tokens stored in `~/.pi/agent/auth.json`, auto-refresh.

---

## API-key providers

| Provider | Env var | `auth.json` key |
|----------|---------|----------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| Azure OpenAI Responses | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` |
| Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK` | `amazon-bedrock` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` | `cloudflare-ai-gateway` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` | `cloudflare-workers-ai` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |
| NVIDIA NIM | `NVIDIA_API_KEY` | `nvidia` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| Together AI | `TOGETHER_API_KEY` | `together` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| Ant Ling | `ANT_LING_API_KEY` | `ant-ling` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` | `zai` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` | `zai-coding-cn` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |

Use `/login` or set env var before starting pi.

---

## Custom models (`~/.pi/agent/models.json`)

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b", "reasoning": false }
      ]
    }
  }
}
```

### API types

| `api` value | Compatible servers |
|-------------|-------------------|
| `"openai-completions"` | Ollama, vLLM, LM Studio, SGLang, text-generation-inference |
| `"openai-responses"` | OpenAI Responses API |
| `"anthropic-messages"` | Anthropic API, proxies |
| `"google-gemini"` | Google AI |
| `"custom"` | Custom implementation via extension |

### Model definition

```typescript
interface ModelDefinition {
  id: string;                                    // Required
  name?: string;                                 // Human-readable
  reasoning?: boolean;                           // Supports extended thinking
  input?: ("text" | "image")[];                 // Supported input types
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;                        // Default 128000
  maxTokens?: number;                            // Default 4096
}
```

### Override built-in provider

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://proxy.example.com"
    }
  }
}
```

---

## Custom providers via extension

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Override baseUrl for existing provider
  pi.registerProvider("anthropic", { baseUrl: "https://proxy.example.com" });

  // Register new provider
  pi.registerProvider("my-provider", {
    name: "My Provider",
    baseUrl: "https://api.example.com/v1",
    apiKey: "$MY_API_KEY",
    api: "openai-completions",
    headers: { "X-Custom": "value" },
    models: [{
      id: "my-model",
      name: "My Model",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
  });
}
```

### Custom streaming API

For `api: "custom"`, implement `ProviderConnection`:

```typescript
pi.registerProvider("custom-llm", {
  name: "Custom LLM",
  baseUrl: "wss://example.com/stream",
  api: "custom",
  apiKey: "$CUSTOM_API_KEY",
  models: [{ id: "custom-model" }],
  connection: {
    stream: async function*(request: ProviderRequest, signal: AbortSignal) {
      // yield ProviderEvent events
      yield { type: "text_delta", delta: "Hello" };
    }
  }
});
```

### Dynamic model discovery (async factory)

```typescript
export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = await response.json();
  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

---

## Resolution order

1. `pi.registerProvider()` in extensions (highest priority)
2. `~/.pi/agent/models.json` custom providers
3. Built-in providers

`registerProvider` with an existing ID merges `baseUrl`, `headers`, `models` (replaces entire model list), and `compat`.
