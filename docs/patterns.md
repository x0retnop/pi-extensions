# Extension Patterns

Copy-paste snippets for common Pi extension tasks.

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
    // force absolute path
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

## Custom TUI component

```ts
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

class MyComponent implements Component {
  constructor(private tui: TUI, private theme: Theme, private done: (result: string) => void) {}

  render(width: number): string[] {
    return [this.theme.fg("accent", "Hello from custom component"))];
  }

  handleInput(data: string): void {
    if (data === "\r") {
      this.done("submitted");
    }
  }

  invalidate(): void {}
}

// In a tool or command handler:
const result = await ctx.ui.custom<string>(
  (tui, theme, _kb, done) => new MyComponent(tui, theme, done)
);
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
  // print/RPC mode — skip UI, return error, or disable the tool
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

## Show a widget above the editor

```ts
ctx.ui.setWidget("my-ext", [
  "Line 1: current status",
  "Line 2: more info",
]);
```

## Listen to raw terminal input

```ts
const unsubscribe = ctx.ui.onTerminalInput((data) => {
  if (data === "\x03") { // Ctrl+C
    return { consume: true };
  }
});
```

## Graceful cleanup on shutdown

```ts
pi.on("session_shutdown", async (_event, _ctx) => {
  // Save temp files, clear intervals, etc.
});
```

## Async factory (fetch config on load)

```ts
export default async function (pi: ExtensionAPI) {
  const res = await fetch("http://localhost:1234/v1/models");
  const payload = await res.json();
  pi.registerProvider("local", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "LOCAL_API_KEY",
    api: "openai-completions",
    models: payload.data.map((m) => ({
      id: m.id,
      name: m.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context_window ?? 128000,
      maxTokens: m.max_tokens ?? 4096,
    })),
  });
}
```

## Render a tool result with colored diff

```ts
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

function diffStats(diff: string) {
  let a = 0, r = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) a++;
    if (line.startsWith("-") && !line.startsWith("---")) r++;
  }
  return { additions: a, removals: r };
}

function colorizeDiff(diff: string, theme: any): string[] {
  // If diff has line numbers like "+47 foo", use native renderDiff
  if (/^[+\- ]\d+\s/.test(diff.split("\n")[0] ?? "")) {
    return renderDiff(diff).split("\n");
  }
  // Otherwise manual coloring for unified diff
  return diff.split("\n").map((line) => {
    if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
    if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
    return theme.fg("toolDiffContext", line);
  });
}

// Inside pi.registerTool:
renderResult(result, options, theme) {
  if (options.isPartial) return { render: () => [], invalidate() {} };

  const diff = result.details?.diff;
  if (!diff) return makePlainText("Done");

  const { additions, removals } = diffStats(diff);
  const header = theme.fg("toolDiffAdded", `+${additions}`)
               + theme.fg("dim", " / ")
               + theme.fg("toolDiffRemoved", `-${removals}`);

  if (!options.expanded) {
    return makePlainText(header);
  }

  const lines = colorizeDiff(diff, theme).map((l) =>
    truncateToWidth(l, width, "...")
  );
  return { render: (w: number) => lines, invalidate() {} };
}
```

## Filter active tools

```ts
// Remove a tool from the active set for the rest of the session
pi.setActiveTools(
  pi.getActiveTools().filter((name) => name !== "my_tool")
);
```

## Send a follow-up message

```ts
pi.sendUserMessage("Please also check the tests.", { deliverAs: "followUp" });
```
