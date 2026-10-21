# Extensions — LLM Reference

> Extension = TypeScript module that extends Pi via events, tools, commands, UI, and providers.
> Entry point: default export `(pi: ExtensionAPI) => void | Promise<void>`.

---

## Quick start

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => { /* intercept */ });
  pi.registerTool({ name: "greet", description: "...", parameters: Type.Object({...}), execute: async (...) => {...} });
  pi.registerCommand("mycmd", { description: "...", handler: async (args, ctx) => {...} });
}
```

---

## Extension locations

| Location | Scope | Auto-reload |
|----------|-------|-------------|
| `~/.pi/agent/extensions/*.ts` | Global | `/reload` |
| `~/.pi/agent/extensions/*/index.ts` | Global (multi-file) | `/reload` |
| `.pi/extensions/*.ts` | Project-local | `/reload` |
| `.pi/extensions/*/index.ts` | Project-local | `/reload` |
| `pi -e ./path.ts` | One-shot test | No |

Additional paths via `settings.json` → `extensions` array.

### Multi-file with npm deps

```
~/.pi/agent/extensions/my-ext/
  ├── package.json       # { "dependencies": {...}, "pi": { "extensions": ["./src/index.ts"] } }
  ├── node_modules/
  └── src/index.ts
```

Run `npm install` in the extension directory.

### Available imports

| Package | Usage |
|---------|-------|
| `@earendil-works/pi-coding-agent` | ExtensionAPI, events, types |
| `typebox` | `Type.Object()`, `Type.String()`, etc. for tool schemas |
| `@earendil-works/pi-ai` | AI utilities (`StringEnum`) |
| `@earendil-works/pi-tui` | TUI components |
| `node:*` | Node built-ins |

---

## Events — lifecycle and reference

### Lifecycle order

```
startup → project_trust → session_start → resources_discover
  → user input → input → before_agent_start → agent_start
  → (turn loop: turn_start → context → before_provider_headers
     → before_provider_request → after_provider_response
     → message_start → message_update → message_end
     → [tool_execution_start → tool_call → tool_execution_update
        → tool_result → tool_execution_end]*
     → turn_end)
  → agent_end → agent_settled

/new or /resume → session_before_switch → session_shutdown → session_start
```

### Event table

| Event | When | Handler return | Can block? |
|-------|------|---------------|------------|
| `project_trust` | Before project resources load | `{ trusted: "yes"\|"no"\|"undecided"; remember? }` or void | Yes (first non-void wins) |
| `resources_discover` | After session start | `{ skillPaths?; promptPaths?; themePaths? }` or void | No |
| `session_start` | Session created/resumed/reloaded | void | No |
| `session_info_changed` | Session name changed | void | No |
| `session_shutdown` | Session ending (quit/reload/switch) | void | No |
| `session_before_switch` | Before switching session | `{ cancel? }` or void | Yes |
| `session_before_fork` | Before forking session | `{ cancel?; skipConversationRestore? }` or void | Yes |
| `session_before_compact` | Before compaction runs | `{ cancel?; compaction? }` or void | Yes |
| `session_before_tree` | Before session-tree navigation | `{ cancel?; summary?; … }` or void | Yes |
| `session_compact` | After compaction | void | No |
| `session_tree` | After tree navigation | void | No |
| `input` | User typed something | `{ action: "continue" \| "transform" \| "handled" }` or void | Yes |
| `before_agent_start` | Before LLM is called | `{ message?; systemPrompt? }` or void | No |
| `agent_start` | LLM call started | void | No |
| `agent_end` | LLM call finished, has messages | void | No |
| `agent_settled` | No retry/compaction/follow-up left | void | No |
| `turn_start` | New LLM turn — `{ turnIndex, timestamp }` | void | No |
| `turn_end` | Turn finished — `{ turnIndex, message, toolResults }` | void | No |
| `context` | Before messages sent to LLM | `{ messages? }` or void | No |
| `before_provider_headers` | Before HTTP request to provider; mutate `headers` in place | void (return ignored) | No |
| `before_provider_request` | Before request is sent | return value **replaces** `payload` | No |
| `after_provider_response` | After HTTP response headers received | void | No |
| `message_start` | Message appeared in transcript | return NOT applied | No |
| `message_update` | Message streaming delta | void | No |
| `message_end` | Message complete | `{ message? }` — replacement must keep the role | No |
| `tool_execution_start` | Tool about to execute | void | No |
| `tool_call` | Tool called by LLM; `input` is **mutable** | `{ block?; reason? }` or void | Yes (block) |
| `tool_execution_update` | Partial tool result | void | No |
| `tool_result` | Tool finished; result lives in `content` | `{ content?; details?; isError?; usage? }` or void | No (modify only) |
| `tool_execution_end` | Tool execution complete in runtime | void | No |
| `model_select` | Model changed — `{ model, previousModel, source }` | void | No |
| `thinking_level_select` | Thinking level changed | void | No |
| `user_bash` | User ran `!`/`!!` bash | `{ operations? }` / `{ result? }` or void | No |

### Important event details

**`tool_call`**: per-tool typed event (see TYPES.md). `event.input` is **mutable** — mutate in place to patch arguments before execution (no re-validation). Return `{ block: true, reason }` to prevent the call — the model retries with the reason. There is no `cancel` in the modern runtime.

**`tool_result`**: per-tool typed event; the tool output is in `event.content`, not `event.output`. `event.usage` may carry usage from the tool execution itself. Return `{ content / details / isError / usage }` to replace the result. Cannot un-call.

**`input`**: `event = { text, images?, source, streamingBehavior? }`. Return `{ action: "handled" }` to consume, `{ action: "transform", text }` to replace, `{ action: "continue" }` to proceed.

**`context`**: `event = { messages }`. Return `{ messages: modified[] }` to add/remove/reorder messages sent to the LLM. Called every turn.

**Important**: `on("context")` handler fires every turn and receives the current message array. Modify with care — can break the agent.

**`message_end`**: return `{ message }` to replace the finalized message; the replacement must keep the original role (runtime rejects role changes).

**`before_provider_headers`** / **`before_provider_request`** / **`after_provider_response`**: together these bracket the real provider HTTP call. Headers are mutated in place (null deletes a header); the request return value replaces the payload; response gives `status` + `headers` only (no body, no usage).

**`turn_start` / `turn_end`**: bracket one LLM turn (a user prompt can spawn many turns). `turnIndex` is 0-based, incremented per turn; `turn_end.toolResults` lists the turn's tool calls.

---

## ExtensionAPI methods

> See `TYPES.md` for full signatures.

| Method | Purpose |
|--------|---------|
| `pi.on(type, handler)` | Subscribe to event |
| `pi.onAny(handler)` | Subscribe to all events |
| `pi.registerTool(def)` | Register a custom tool |
| `pi.getTools()` | List registered tools |
| `pi.registerCommand(name, opts)` | Register `/command` |
| `pi.getCommands()` | List command names |
| `pi.registerShortcut(keys, opts)` | Register keyboard shortcut |
| `pi.registerFlag(name, opts)` | Register CLI flag `--flag` |
| `pi.registerProvider(id, config)` | Register/modify provider |
| `pi.unregisterProvider(id)` | Remove provider |
| `pi.sendMessage(content, opts?)` | Send custom-role message (hidden by default) |
| `pi.sendUserMessage(content, opts?)` | Send user-role message |
| `pi.appendEntry(customType, data?)` | Persist extension data |
| `pi.setSessionName(name)` | Set session display name |
| `pi.getSessionName()` | Get session name |
| `pi.setLabel(entryId, label)` | Bookmark an entry |
| `pi.getEntryLabel(entryId)` | Read entry label |
| `pi.registerEntryRenderer(customType, renderer)` | Render custom entries in transcript |

---

## `ctx` (ExtensionContext / ExtensionCommandContext)

```typescript
ctx.ui.notify(message, level)           // "info" | "warn" | "error"
ctx.ui.setStatus(namespace, text|null)  // Footer status line
ctx.ui.setWidget(namespace, lines|null) // Widget above/below editor
ctx.ui.confirm(title, message)          // → Promise<boolean>
ctx.ui.select(title, options)           // → Promise<T | undefined>
ctx.ui.input(title, placeholder?, default?) // → Promise<string | undefined>
ctx.ui.custom(component, opts?)         // Mount custom TUI component
ctx.ui.progress(title, opts?)           // → { update, done }

ctx.sessionManager.getEntries()         // All session entries
ctx.sessionManager.getActiveEntry()     // Current entry
ctx.sessionManager.getEntry(id)         // By ID
ctx.sessionManager.save()               // Flush to disk
ctx.sessionManager.load(file)           // Load from file
ctx.sessionManager.getHeader()          // Session header
ctx.sessionManager.getLabel(id)         // Read label
ctx.sessionManager.setLabel(id, label)  // Write label
```

---

## Custom tools

```typescript
pi.registerTool({
  name: "my-tool",                    // Unique, LLM-visible
  label: "My Tool",                   // Human label (optional)
  description: "Does X when Y",       // LLM prompt description
  parameters: Type.Object({           // TypeBox schema
    input: Type.String(),
    count: Type.Optional(Type.Number({ default: 1 })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // signal = AbortSignal for cancellation
    // onUpdate(data) = stream partial results
    // ctx = ToolExecutionContext (extends ExtensionCommandContext)
    return {
      content: [{ type: "text", text: `Result: ${params.input}` }],
      details: { /* metadata for tool_result event */ },
      isError: false,  // Default
    };
  },
});
```

`AgentToolResult` may also carry:
- `isError: true` — report a failure to the model without throwing (`content` becomes the error result).
- `terminate: true` — hint that the agent should stop after the current tool batch; it only takes
  effect when **every** finalized tool result in the batch sets it.
- `structuredContent` — matches the tool's `outputSchema` for programmatic callers; not sent to the
  model.

### Tool registration timing

Tools can be registered from:
- Extension factory (available immediately)
- Any event handler (deferred)
- Use `pi.getTools()` to inspect current tools

### Dynamic tool loading

Register tools later (e.g., from `session_start`) when tools depend on session state.

---

## State management

```typescript
// Persist arbitrary data to session file (not LLM-visible)
pi.appendEntry("my-state", { count: 42 });

// Restore on session start
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // entry.data === { count: 42 }
    }
  }
});

// Custom entry renderer (for transcript display)
pi.registerEntryRenderer("status-card", {
  render: (entry, isActive) => [`Status: ${entry.data.title} — ${entry.data.count} items`],
  minHeight: 1,
});
```

---

## Rendering customization

### Tool call/result rendering

```typescript
// In ToolDefinition:
execute: async (toolCallId, params, signal, onUpdate, ctx) => {
  return {
    content: [{ type: "text", text: "..." }],
    details: { renderCall: (toolName: string, args: any) => string[],
               renderResult: (toolName: string, args: any, result: any) => string[] },
  };
}
```

### Entry renderer for `pi.appendEntry`

```typescript
pi.registerEntryRenderer("status-card", {
  render: (entry: CustomEntry, isActive: boolean) => [
    `┌──────────────┐`,
    `│ ${entry.data.title} │`,
    `└──────────────┘`,
  ],
  minHeight: 3,
});
```

---

## Error handling

```typescript
// In tool execute — return isError, don't throw
return { content: [{ type: "text", text: "Failed" }], isError: true };

// Unhandled throws in event handlers — Pi logs and continues
// Unhandled throws in tool execute — Pi catches and reports to LLM

// Async factory — Pi awaits before continuing startup
export default async function (pi: ExtensionAPI) {
  await fetch(...); // Blocks startup
}
```

---

## Mode behavior notes

- **Interactive**: full UI, all `ctx.ui` methods work
- **JSON mode**: no UI; `ctx.ui.notify/confirm/select/input` are no-ops or throw
- **RPC mode**: same as JSON mode
- **Print mode** (`-p`): no UI, single-turn

Check for UI availability: `ctx.ui.confirm` will throw in non-interactive modes.
Catch or check `ctx.ui` before calling interactive methods.

---

## Examples (canonical)

### Permission gate

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    const ok = await ctx.ui.confirm("Dangerous!", `Allow: ${event.input.command}`);
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
});
```

### Git checkpoint

```typescript
pi.on("turn_end", async (_event, ctx) => {
  // Auto-stash after each turn
});
```

### Path protection

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "write" && event.input.path?.includes(".env")) {
    return { block: true, reason: ".env is protected" };
  }
});
```
