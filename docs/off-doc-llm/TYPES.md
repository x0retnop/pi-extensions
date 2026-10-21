# Pi Types — Compact Reference

All key TypeScript types from `@earendil-works/pi-coding-agent`.

---

## Extension Events

```typescript
// Event union (source of truth: dist/core/extensions/types.d.ts)
type ExtensionEvent =
  | { type: "project_trust"; cwd: string }
  | { type: "resources_discover"; cwd: string; reason: "startup" | "reload" }
  | { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "session_before_switch"; reason: "new" | "resume"; targetSessionFile?: string }
  | { type: "session_before_fork"; entryId: string; position: "before" | "at" }
  | { type: "session_before_compact"; preparation: CompactionPreparation; branchEntries: SessionEntry[]; customInstructions?: string; reason: "manual" | "threshold" | "overflow"; willRetry: boolean; signal: AbortSignal }
  | { type: "session_compact"; compactionEntry: CompactionEntry; fromExtension: boolean; reason: "manual" | "threshold" | "overflow"; willRetry: boolean }
  | { type: "session_shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string }
  | { type: "session_before_tree"; preparation: TreePreparation; signal: AbortSignal }
  | { type: "session_tree"; newLeafId: string | null; oldLeafId: string | null; summaryEntry?: BranchSummaryEntry; fromExtension?: boolean }
  | { type: "input"; text: string; images?: ImageContent[]; source: InputSource; streamingBehavior?: "steer" | "followUp" }
  | { type: "before_agent_start"; prompt: string; images?: ImageContent[]; systemPrompt: string; systemPromptOptions: BuildSystemPromptOptions }
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "agent_settled" }
  | { type: "turn_start"; turnIndex: number; timestamp: number }
  | { type: "turn_end"; turnIndex: number; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "context"; messages: AgentMessage[] }
  | { type: "before_provider_headers"; headers: ProviderHeaders }
  | { type: "before_provider_request"; payload: unknown }
  | { type: "after_provider_response"; status: number; headers: Record<string, string> }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
  | { type: "model_select"; model: Model<any>; previousModel: Model<any> | undefined; source: "set" | "cycle" | "restore" }
  | { type: "thinking_level_select"; level: ThinkingLevel; previousLevel: ThinkingLevel }
  | { type: "user_bash"; command: string; excludeFromContext: boolean; cwd: string }
  | ToolCallEvent // per-tool union, см. ниже
  | ToolResultEvent // per-tool union, см. ниже
```

`tool_call` / `tool_result` — per-tool union (built-ins типизированы, кастомные — `CustomToolCallEvent`/`CustomToolResultEvent`):

```typescript
interface ToolCallEventBase { type: "tool_call"; toolCallId: string }
type ToolCallEvent =
  | (ToolCallEventBase & { toolName: "bash"; input: BashToolInput })
  | (ToolCallEventBase & { toolName: "read"; input: ReadToolInput })
  | (ToolCallEventBase & { toolName: "edit"; input: EditToolInput })
  | (ToolCallEventBase & { toolName: "write"; input: WriteToolInput })
  | (ToolCallEventBase & { toolName: "grep"; input: GrepToolInput })
  | (ToolCallEventBase & { toolName: "find"; input: FindToolInput })
  | (ToolCallEventBase & { toolName: "ls"; input: LsToolInput })
  | { type: "tool_call"; toolName: string; toolCallId: string; input: Record<string, unknown> } // custom
// event.input МУТИРУЕМ: меняй в месте, чтобы пропатчить аргументы до выполнения.
// Узкое место: CustomToolCallEvent.toolName — string, поэтому
// event.toolName === "bash" не сужает тип; используй isToolCallEventType("bash", event).

interface ToolResultEventBase {
  type: "tool_result";
  toolCallId: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  usage?: Usage; // usage самой тул-экзекуции, если есть
}
type ToolResultEvent =
  | (ToolResultEventBase & { toolName: "bash"; details: BashToolDetails | undefined })
  | (ToolResultEventBase & { toolName: "read"; details: ReadToolDetails | undefined })
  | (ToolResultEventBase & { toolName: "edit"; details: EditToolDetails | undefined })
  | (ToolResultEventBase & { toolName: "write"; details: undefined })
  | (ToolResultEventBase & { toolName: "grep"; details: GrepToolDetails | undefined })
  | (ToolResultEventBase & { toolName: "find"; details: FindToolDetails | undefined })
  | (ToolResultEventBase & { toolName: "ls"; details: LsToolDetails | undefined })
  | (ToolResultEventBase & { toolName: string; details: unknown }) // custom
// ВАЖНО: нет поля output — результат лежит в content. Замена результата через return.
```

### Event handler return values

```typescript
// project_trust result (first non-void wins)
type ProjectTrustEventResult = { trusted: "yes" | "no" | "undecided"; remember?: boolean }

// resources_discover result
type ResourcesDiscoverResult = { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] }

// input result
type InputEventResult =
  | { action: "continue" }                                    // Proceed as-is
  | { action: "transform"; text: string; images?: ImageContent[] } // Replace input
  | { action: "handled" }                                     // Extension consumed the input
  | undefined | void

// before_agent_start result
type BeforeAgentStartEventResult =
  | { message?: Pick<CustomMessage, "customType" | "content" | "display" | "details"> }
  | { systemPrompt?: string }  // chained if multiple extensions return it
  | undefined | void

// context result
type ContextEventResult =
  | { messages?: AgentMessage[] }   // Replace messages
  | undefined | void

// before_provider_headers: handlers МУТИРУЮТ headers на месте, return игнорируется; null удаляет заголовок

// before_provider_request: return значение = замена payload (любой тип)

// message_end result (replacement MUST keep the original role)
type MessageEndEventResult =
  | { message?: AgentMessage }
  | undefined | void

// tool_call result
type ToolCallEventResult =
  | { block?: boolean; reason?: string }   // block → tool не выполняется, модель повторяет с reason
  | undefined | void

// tool_result result
type ToolResultEventResult =
  | { content?: (TextContent | ImageContent)[]; details?: unknown; isError?: boolean; usage?: Usage }
  | undefined | void                       // Keep original

// user_bash result
type UserBashEventResult =
  | { operations?: BashOperations }        // Custom operations for execution
  | { result?: BashResult }                // Full replacement: extension handled execution
  | undefined | void

// session_before_switch result
type SessionBeforeSwitchResult =
  | { cancel?: boolean }
  | undefined | void

// session_before_fork result
type SessionBeforeForkResult =
  | { cancel?: boolean; skipConversationRestore?: boolean }
  | undefined | void

// session_before_compact result
type SessionBeforeCompactResult =
  | { cancel?: boolean; compaction?: CompactionResult }
  | undefined | void

// session_before_tree result
type SessionBeforeTreeResult =
  | { cancel?: boolean; summary?: { summary: string; details?: unknown; usage?: Usage };
      customInstructions?: string; replaceInstructions?: boolean; label?: string }
  | undefined | void

// message_start: return НЕ применяется (runner диспатчит через общий emit, спец-обработки нет)
```

---

## ExtensionContext (ctx)

```typescript
interface ExtensionContext {
  ui: ExtensionUIContext;
  sessionManager: SessionManager;
  api: ExtensionAPI;
}

interface ExtensionCommandContext {
  ui: ExtensionUIContext;
  sessionManager: SessionManager;
  api: ExtensionAPI;
  args: string;     // Raw arguments after command name
}
```

### ExtensionUIContext

```typescript
interface ExtensionUIContext {
  notify(message: string, level: "info" | "warn" | "error"): void;
  setStatus(namespace: string, status: string | null): void;
  setWidget(namespace: string, lines: string[] | null, position?: "above-editor" | "below-editor"): void;
  confirm(title: string, message: string): Promise<boolean>;
  select<T>(title: string, options: { label: string; value: T }[]): Promise<T | undefined>;
  input(title: string, placeholder?: string, defaultValue?: string): Promise<string | undefined>;
  custom(component: Component, options?: { border?: boolean; title?: string }): Promise<void>;
  progress(title: string, options?: { total?: number }): { update: (current: number, message?: string) => void; done: () => void };
}
```

---

## ExtensionAPI Methods (pi)

### Event subscription

```typescript
pi.on(type: "tool_call" | "tool_result" | "session_start" | ..., handler: (event, ctx) => Promise<Result> | Result | void): void;
pi.onAny(handler: (event, ctx) => void): void;
```

### Tool registration

```typescript
// ToolDefinition
interface ToolDefinition {
  name: string;                                    // Unique tool name
  label?: string;                                  // Human-readable label
  description: string;                             // LLM-facing description
  parameters: TSchema;                             // TypeBox schema
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal,
    onUpdate: (data: any) => void,
    ctx: ToolExecutionContext
  ) => Promise<ToolResult>;
}

interface ToolExecutionContext extends ExtensionCommandContext {
  toolCallId: string;
  toolName: string;
}

interface ToolResult {
  content: ToolContent[];                          // [{ type: "text", text: string } | { type: "image", ... }]
  details?: Record<string, any>;
  isError?: boolean;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

pi.registerTool(def: ToolDefinition): void;
pi.getTools(): ToolDefinition[];
```

### Command registration

```typescript
pi.registerCommand(name: string, opts: {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
}): void;

interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

pi.getCommands(): string[];
```

### Provider registration

```typescript
pi.registerProvider(id: string, config: ProviderConfig): void;
pi.unregisterProvider(id: string): ProviderConfig | undefined;

interface ProviderConfig {
  name?: string;
  baseUrl: string;
  apiKey?: string;          // Literal key or "$ENV_VAR" reference
  api: "anthropic-messages" | "openai-completions" | "openai-responses" | "google-gemini" | "custom";
  headers?: Record<string, string>;
  models: ModelDefinition[];
  compat?: { supportsDeveloperRole?: boolean; supportsReasoningEffort?: boolean };
}

interface ModelDefinition {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
}
```

### Shortcuts & Flags

```typescript
pi.registerShortcut(keys: string, opts: {
  description: string;
  handler: (ctx: ExtensionCommandContext) => void | Promise<void>;
}): void;

pi.registerFlag(name: string, opts: {
  description: string;
  handler: (value: string | true, ctx: ExtensionCommandContext) => void | Promise<void>;
}): void;
```

### Messaging

```typescript
// Send a custom message (custom role, hidden by default)
pi.sendMessage(content: string | ToolContent[], options?: {
  mode?: "steer" | "followUp" | "nextTurn";
  triggerTurn?: boolean;
}): Promise<void>;

// Send a user message (visible, always triggers turn)
pi.sendUserMessage(content: string | ToolContent[], options?: {
  deliverAs?: "steer" | "followUp";
}): Promise<void>;
```

### Session & State

```typescript
pi.appendEntry(customType: string, data?: any): void;
pi.setSessionName(name: string): void;
pi.getSessionName(): string | undefined;
pi.setLabel(entryId: string, label: string | undefined): void;
pi.getEntryLabel(entryId: string): string | undefined;
```

### Rendering

```typescript
pi.registerEntryRenderer(customType: string, renderer: {
  render: (entry: CustomEntry, isActive: boolean) => string[];
  minHeight?: number;
}): void;

// Render customization for tool calls/results
renderCall?: (toolName: string, args: any) => string[];
renderResult?: (toolName: string, args: any, result: any) => string[];
```

---

## SessionManager

```typescript
interface SessionManager {
  getEntries(): SessionEntry[];
  getActiveEntry(): SessionEntry | undefined;
  getEntry(id: string): SessionEntry | undefined;
  getActiveBranchIds(): string[];
  getLabel(entryId: string): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  getHeader(): SessionHeader;
  getSessionFile(): string | undefined;
  getTokenCount(message?: AgentMessage): number;
  save(): Promise<void>;
  load(file: string): Promise<void>;
}

type SessionEntry =
  | SessionHeader
  | SessionMessageEntry       // type: "message"
  | CompactionEntry           // type: "compaction"
  | BranchSummaryEntry        // type: "branch_summary"
  | CustomEntry;              // type: "custom"

interface SessionHeader {
  type: "header";
  id: string;
  version: number;            // Current: 3
  tree: { rootId: string; branches: Record<string, { parentId: string }> };
  createdAt: number;
  updatedAt: number;
  name?: string;
  agentVersion?: string;
  workingDirectory?: string;
}

interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  message: AgentMessage;
  createdAt: number;
  label?: string;
  metadata?: Record<string, any>;
}

interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string | null;
  summary: {
    messages: { role: string; summary: string }[];
    completedTasks: string[];
    pendingTasks: string[];
    filesRead: string[];
    filesWritten: string[];
    decisions: string[];
    importantContext: string[];
  };
  firstKeptEntryId: string;
  createdAt: number;
}

interface CustomEntry {
  type: "custom";
  id: string;
  parentId: string | null;
  customType: string;
  data?: any;
  createdAt: number;
}
```

### AgentMessage types

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  timestamp: number;
}

interface ToolResultMessage {
  role: "tool_result";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

interface TextContent { type: "text"; text: string }
interface ImageContent { type: "image"; data: string; mimeType: string }
interface ThinkingContent { type: "thinking"; thinking: string }
interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, any> }

interface BashExecutionMessage {
  role: "tool_result";
  toolCallId: string;
  toolName: "bash";
  content: (TextContent | ImageContent)[];
  isError: boolean;
  executedCommand: string;
  exitCode: number;
}

interface CustomMessage {
  role: "custom";
  content: string | (TextContent | ImageContent)[];
  customType: string;
}
```

---

## Built-in tool input/output types

```typescript
interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;           // ms, default 120000
  maxOutput?: number;         // bytes, default 10240
  failOnError?: boolean;      // default true
  workdir?: string;
}

interface ReadToolInput {
  path: string;
  mode?: "overview" | "section" | "raw";
  target?: string;
  offset?: number;
  limit?: number;
}

interface WriteToolInput {
  path: string;
  content: string;
}

interface EditToolInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "content" | "files_with_matches" | "count_matches";
  multiline?: boolean;
  fixed_strings?: boolean;
  word_match?: boolean;
  "-i"?: boolean;
  "-C"?: number;
  "-B"?: number;
  "-A"?: number;
  head_limit?: number;
  include_ignored?: boolean;
}

interface FindToolInput {
  pattern: string;
  path?: string;
  type?: string;
}

interface LsToolInput {
  path: string;
}
```

---

## TUI Component interfaces

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}

interface Focusable {
  focused: boolean;
}

const CURSOR_MARKER: string;  // Zero-width APC for hardware cursor positioning
```

---

## SDK types

```typescript
interface AgentSession {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;
  subscribe(handler: (event: AgentSessionEvent) => void): () => void;
  getEvents(): AgentSessionEvent[];
  getEntries(): SessionEntry[];
  getModel(): string;
  abort(): Promise<void>;
  destroy(): Promise<void>;
}

async function createAgentSession(options?: {
  model?: string | ModelConfig;
  tools?: string[];
  sessionManager?: SessionManager;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  extensions?: ExtensionLoader[];
  skills?: SkillLoader[];
  resourceLoader?: ResourceLoader;
}): Promise<{ session: AgentSession; cleanup: () => Promise<void> }>;
```

---

## Provider registration — Config reference

```typescript
// Full ProviderConfig
{
  name: "My Provider";
  baseUrl: "https://api.example.com/v1";
  apiKey: "$MY_API_KEY";                    // "$ENV_VAR" or literal
  api: "anthropic-messages"                 // or "openai-completions" | "openai-responses" | "google-gemini" | "custom"
      | "openai-completions"
      | "openai-responses"
      | "google-gemini"
      | "custom";
  headers: { "X-Custom": "value" };          // Optional extra headers
  models: [{ id: "my-model", ... }];         // See ModelDefinition above
  compat: {
    supportsDeveloperRole?: boolean;         // Default true
    supportsReasoningEffort?: boolean;       // Default true
  };
}

// For "custom" API type, implement ProviderConnection:
interface ProviderConnection {
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
```

---

## Theme type

```typescript
interface Theme {
  name: string;
  vars: Record<string, string | number>;  // Name → hex/#rgb or 0-255 ANSI
}

// Required color tokens:
// primary, secondary, success, warning, error, info,
// background, surface, border, text, textMuted, textAccent,
// editorBg, editorText, editorCursor, editorSelection,
// selectionBg, selectionText, lineNumbers,
// scrollbar, scrollbarHover, scrollbarActive,
// tooltipBg, tooltipText, tooltipBorder
```

---

## Compaction summary shape

```typescript
interface CompactionSummary {
  messages: { role: string; summary: string }[];
  completedTasks: string[];
  pendingTasks: string[];
  filesRead: string[];
  filesWritten: string[];
  decisions: string[];
  importantContext: string[];
}
```

---

## RPC command types

```typescript
type RpcCommand =
  | { type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp"; id?: string }
  | { type: "steer"; message: string; id?: string }
  | { type: "abort"; id?: string }
  | { type: "get_session"; id?: string }
  | { type: "new_session"; options?: { name?: string }; id?: string }
  | { type: "get_entries"; id?: string }
  | { type: "set_tools"; tools: string[]; id?: string }
  | { type: "ping"; id?: string };

type RpcResponse = {
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: any;
  id?: string;
};
```
