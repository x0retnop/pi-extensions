# Extension Patterns

Copy-paste snippets for common Pi extension tasks. For deeper internals, see `docs/pi-quickref.md`, `docs/pi-tool-internals.md`, and `docs/tool-rendering.md`.

## Register a tool with TypeBox

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });
}
```

## Register a slash command

```ts
pi.registerCommand("hello", {
  description: "Say hello",
  handler: async (args, ctx) => {
    ctx.ui.notify(`Hello ${args || "world"}!`, "info");
  },
});
```

## Block a tool call

```ts
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
});
```

## Mutate tool arguments before execution

```ts
pi.on("tool_call", async (event) => {
  if (event.toolName === "read") {
    event.input.path = path.resolve(event.input.path);
  }
});
```

## Modify a tool result

```ts
pi.on("tool_result", async (event) => {
  if (event.toolName === "bash") {
    return {
      content: event.content,
      details: { ...event.details, audited: true },
    };
  }
});
```

## Persist state in the session

```ts
pi.appendEntry("my-extension-state", { count: 42 });

// Later, read back from session entries:
const entries = ctx.sessionManager.getEntries();
const state = entries.find(e => e.customType === "my-extension-state")?.data;
```

## Handle non-interactive sessions

```ts
if (!ctx.hasUI) {
  return {
    content: [{ type: "text", text: "This tool requires an interactive session." }],
    details: {},
  };
}
```

## Set footer status

```ts
ctx.ui.setStatus("my-ext", "Processing...");
// Clear later:
ctx.ui.setStatus("my-ext", undefined);
```

## Graceful cleanup on shutdown

```ts
pi.on("session_shutdown", async (_event, _ctx) => {
  // Save temp files, clear intervals, etc.
});
```

## Filter active tools

```ts
pi.setActiveTools(
  pi.getActiveTools().filter((name) => name !== "my_tool")
);
```

## Override a built-in tool and delegate to original

```ts
import { createReadTool } from "@earendil-works/pi-coding-agent";

const originalRead = createReadTool(process.cwd());

// In your override execute():
return originalRead.execute(toolCallId, params, signal, onUpdate);
```

## promptGuidelines matter more than description

`description` is for humans. `promptGuidelines` are injected into the system prompt and strongly influence agent behavior.

```ts
pi.registerTool({
  name: "read",
  description: "Read files...",
  promptGuidelines: [
    "Use mode:overview FIRST for files >200 lines.",
    "Use mode:section with a target name to read a specific block.",
  ],
  // ...
});
```

## Cross-extension communication

```ts
// Extension A
pi.events.emit("my:event", { data: 42 });

// Extension B
pi.events.on("my:event", (payload) => {
  console.log(payload.data); // 42
});
```

## Safe truncation for custom renderers

```ts
function safeTruncate(str: string, maxWidth: number, suffix = "..."): string {
  let visible = 0;
  let result = "";
  let inAnsi = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    if (ch === 0x1b && str.charCodeAt(i + 1) === 0x5b) {
      inAnsi = true;
      result += str[i];
      continue;
    }
    if (inAnsi) {
      result += str[i];
      if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a)) {
        inAnsi = false;
      }
      continue;
    }
    if (visible >= maxWidth - suffix.length) {
      result += suffix;
      break;
    }
    result += str[i];
    visible++;
  }
  return result;
}
```
