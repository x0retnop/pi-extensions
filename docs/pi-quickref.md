# Pi Extension API Quick Reference

Condensed reference for agents writing or editing Pi extensions. Based on `@earendil-works/pi-coding-agent` types and https://pi.dev/docs/latest.

## Extension factory

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // sync or async initialization
}
```

## Registering a tool

```ts
import { Type } from "typebox";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What the LLM should know about this tool.",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return {
      content: [{ type: "text", text: "Done" }],
      details: {},
    };
  },
});
```

Tool execution must return `AgentToolResult<TDetails>`:

```ts
{
  content: (TextContent | ImageContent)[];
  details?: TDetails;
}
```

Optional renderers:

```ts
renderCall(args, theme, context) => Component
renderResult(result, options, theme, context) => Component
```

## Registering a command

```ts
pi.registerCommand("mycommand", {
  description: "Do something",
  handler: async (args, ctx) => {
    ctx.ui.notify(`Args: ${args}`, "info");
  },
});
```

## Events

Subscribe with `pi.on(event, handler)`. Handler receives `(event, ctx: ExtensionContext)` and may return a control object.

### Session events

| Event | Return type | Notes |
|---|---|---|
| `resources_discover` | `{ skillPaths?, promptPaths?, themePaths? }` | Fired after `session_start`. |
| `session_start` | void | `reason`: startup / reload / new / resume / fork. |
| `session_before_switch` | `{ cancel?: boolean }` | Before `/new` or `/resume`. |
| `session_before_fork` | `{ cancel?: boolean }` | Before `/fork` or `/clone`. |
| `session_before_compact` | `{ cancel?: boolean, compaction?: CompactionResult }` | Can provide custom summary. |
| `session_compact` | void | After compaction finishes. |
| `session_before_tree` | `{ cancel?: boolean, summary? }` | Before `/tree` navigation. |
| `session_tree` | void | After tree navigation. |
| `session_shutdown` | void | Cleanup before runtime teardown. |

### Agent / turn events

| Event | Return type | Notes |
|---|---|---|
| `before_agent_start` | `{ message?, systemPrompt? }` | Inject context or replace system prompt. |
| `agent_start` | void | |
| `agent_end` | void | |
| `turn_start` | void | |
| `turn_end` | void | |
| `context` | `{ messages? }` | Can modify messages array before LLM call. |
| `before_provider_request` | `unknown` (replace payload) | Inspect/replace provider payload. |
| `after_provider_response` | void | Inspect headers/status before stream consumption. |

### Message events

| Event | Return type | Notes |
|---|---|---|
| `message_start` | void | |
| `message_update` | void | Streaming token updates. |
| `message_end` | `{ message? }` | Can replace finalized message (keep role). |

### Tool events

| Event | Return type | Notes |
|---|---|---|
| `tool_execution_start` | void | |
| `tool_execution_update` | void | Streaming partial results. |
| `tool_execution_end` | void | |
| `tool_call` | `{ block?: boolean, reason? }` | Block or mutate `event.input` in place. |
| `tool_result` | `{ content?, details?, isError? }` | Modify result before it reaches the LLM. |

### Other events

| Event | Return type | Notes |
|---|---|---|
| `model_select` | void | |
| `thinking_level_select` | void | |
| `user_bash` | `{ operations?, result? }` | Intercept `!` / `!!` commands. |
| `input` | `{ action: "continue" | "transform" | "handled", text?, images? }` | Intercept or transform user input. |

## ExtensionContext

Available in all event handlers:

```ts
ctx.ui          // ExtensionUIContext — select, confirm, input, notify, custom, setStatus, setWidget, etc.
ctx.hasUI       // boolean — false in print/RPC mode
ctx.cwd         // string — current working directory
ctx.sessionManager // ReadonlySessionManager — getSessionFile(), getEntries(), etc.
ctx.modelRegistry  // ModelRegistry
ctx.model       // Model<any> | undefined
ctx.isIdle()    // boolean
ctx.signal      // AbortSignal | undefined
ctx.abort()     // Abort current agent operation
ctx.getContextUsage() // { tokens, contextWindow, percent } | undefined
ctx.compact(options?)
ctx.getSystemPrompt()
```

## ExtensionCommandContext

Available in command handlers (extends `ExtensionContext`):

```ts
ctx.waitForIdle()
ctx.newSession(options?)
ctx.fork(entryId, options?)
ctx.navigateTree(targetId, options?)
ctx.switchSession(sessionPath, options?)
ctx.reload()
```

## ExtensionAPI (pi)

```ts
pi.registerTool(tool: ToolDefinition)
pi.registerCommand(name, options)
pi.registerShortcut(shortcut: KeyId, options)
pi.registerFlag(name, options)
pi.getFlag(name)
pi.registerMessageRenderer(customType, renderer)
pi.sendMessage(message, options?)
pi.sendUserMessage(content, options?)
pi.appendEntry(customType, data?)      // Persist state in session
pi.setSessionName(name)
pi.getSessionName()
pi.setLabel(entryId, label?)
pi.exec(command, args, options?)       // Shell execution
pi.getActiveTools()
pi.getAllTools()
pi.setActiveTools(toolNames)
pi.getCommands()
pi.setModel(model)
pi.getThinkingLevel()
pi.setThinkingLevel(level)
pi.registerProvider(name, config)
pi.unregisterProvider(name)
pi.events  // EventBus for cross-extension comms
```

## UI primitives (ctx.ui)

```ts
ctx.ui.select(title, options[], opts?) => Promise<string | undefined>
ctx.ui.confirm(title, message, opts?) => Promise<boolean>
ctx.ui.input(title, placeholder?, opts?) => Promise<string | undefined>
ctx.ui.notify(message, type?: "info" | "warning" | "error")
ctx.ui.setStatus(key, text?)
ctx.ui.setWidget(key, content?, options?)
ctx.ui.setFooter(factory?)
ctx.ui.setHeader(factory?)
ctx.ui.setTitle(title)
ctx.ui.custom<T>(factory, options?) => Promise<T>
ctx.ui.editor(title, prefill?) => Promise<string | undefined>
ctx.ui.pasteToEditor(text)
ctx.ui.setEditorText(text)
ctx.ui.getEditorText()
ctx.ui.addAutocompleteProvider(factory)
ctx.ui.setEditorComponent(factory?)
ctx.ui.getEditorComponent()
ctx.ui.theme  // Theme instance
ctx.ui.getAllThemes()
ctx.ui.getTheme(name)
ctx.ui.setTheme(theme)
ctx.ui.getToolsExpanded()
ctx.ui.setToolsExpanded(expanded)
```

## TypeBox quick patterns

```ts
import { Type } from "typebox";

Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  count: Type.Integer({ minimum: 0, maximum: 100 }),
  enabled: Type.Boolean(),
  tags: Type.Array(Type.String(), { maxItems: 10 }),
})
```

For Google-compatible string enums use `StringEnum` from `@earendil-works/pi-ai`:

```ts
import { StringEnum } from "@earendil-works/pi-ai";
Type.Object({
  mode: StringEnum(["strict", "balanced", "relaxed"]),
})
```

## Peer dependencies in this collection

Packages should list these as `peerDependencies` (not bundled):

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-tui`
- `typebox`

Runtime deps that are not Pi core packages go in `dependencies`.
