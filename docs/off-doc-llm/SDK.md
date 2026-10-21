# SDK

> Programmatic access to Pi agent capabilities.
> `npm install @earendil-works/pi-coding-agent` — no separate package.

---

## Quick start

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
```

---

## Core API

### createAgentSession

```typescript
async function createAgentSession(options?: {
  model?: string | ModelConfig;
  tools?: string[];                              // Tool names to enable
  sessionManager?: SessionManager;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  extensions?: ExtensionLoader[];
  skills?: SkillLoader[];
  resourceLoader?: ResourceLoader;               // Default: DefaultResourceLoader
}): Promise<{ session: AgentSession; cleanup: () => Promise<void> }>;
```

If no `sessionManager` provided, uses `DefaultResourceLoader` with standard discovery.

### AgentSession

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // Queue a message during streaming
  steer(text: string): Promise<void>;

  // Subscribe to all events
  subscribe(handler: (event: AgentSessionEvent) => void): () => void;  // Returns unsubscribe

  // Get buffered events
  getEvents(): AgentSessionEvent[];

  // Session entries
  getEntries(): SessionEntry[];

  // Current model ID
  getModel(): string;

  // Abort current run
  abort(): Promise<void>;

  // Cleanup
  destroy(): Promise<void>;
}
```

### PromptOptions

```typescript
interface PromptOptions {
  images?: ImageContent[];                       // Attach images
  streamingBehavior?: "steer" | "followUp";     // During active streaming
  signal?: AbortSignal;                          // Abort
}
```

---

## Events (AgentSessionEvent)

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

---

## Recipes

### Custom UI (web wrapper)

```typescript
const { session } = await createAgentSession({ ... });
session.subscribe((event) => {
  // Forward events to WebSocket/HTTP
  ws.send(JSON.stringify(event));
});
```

### Automated pipeline

```typescript
const { session } = await createAgentSession({ tools: ["read", "bash"] });
await session.prompt("Run tests and report results");
const events = session.getEvents();
// Inspect tool results
```

### Sub-agent

```typescript
const { session: subAgent } = await createAgentSession({
  model: "claude-sonnet-4-20250514",
  tools: ["read", "grep"],
  sessionManager: SessionManager.inMemory(),
});
await subAgent.prompt("Analyze the code structure in src/");
subAgent.destroy();
```
