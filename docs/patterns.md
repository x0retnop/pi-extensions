# Extension Patterns

Copy-paste snippets for common Pi extension tasks. Owner of snippets only — the API reference is
`docs/off-doc-llm/EXTENSIONS.md`, types are `docs/off-doc-llm/TYPES.md`. For deeper internals see
`docs/pi-tool-internals.md` and `docs/tool-rendering.md`.

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

## Where tool text actually goes (description vs promptSnippet/promptGuidelines)

The provider receives only the tool schema — `description` + `parameters` (including each
field's `description`). `promptSnippet`/`promptGuidelines` are **not** sent: they feed only
Pi's *default* system block, which `buildSystemPrompt` skips whenever a custom prompt is set
(`SYSTEM.md` / `--system-prompt`). This host always runs a role (`role-sw`), so guidelines
never reach the model. Verified by payload capture — see `docs/pi-tool-internals.md` §3.

=> Put call rules in `description` (or a field's `description`); put cross-tool policy in the role.
A role does not replace schema text (blank prompt / other role never sees it). Schema text does not replace the role (`promptGuidelines` are still not sent).

```ts
pi.registerTool({
  name: "read",
  description:
    "Read files... Use mode:overview FIRST for files >200 lines; " +
    "mode:section with a target name for one block.",
  parameters: Type.Object({
    mode: Type.Optional(StringEnum(["overview", "section", "raw"], {
      description: "Reading mode. Default is raw.",
    })),
  }),
  // Do NOT rely on promptGuidelines — skipped under a custom prompt.
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

Canonical copy — the renderer docs point here. Counts only visible cells and preserves ANSI (tab/CR-normalized, surrogate-pair and wide-CJK/emoji aware):

```ts
function safeTruncate(str: string, maxWidth: number, suffix = "..."): string {
  str = str.replace(/\t/g, " ").replace(/\r/g, "");
  let visible = 0;
  let result = "";
  let inAnsi = false;

  for (let i = 0; i < str.length; ) {
    const chCode = str.charCodeAt(i);
    if (chCode === 0x1b && str.charCodeAt(i + 1) === 0x5b) {
      inAnsi = true;
      result += str[i++];
      continue;
    }
    if (inAnsi) {
      result += str[i];
      if ((chCode >= 0x41 && chCode <= 0x5a) || (chCode >= 0x61 && chCode <= 0x7a)) {
        inAnsi = false;
      }
      i++;
      continue;
    }
    let ch: string;
    let step: number;
    if (chCode >= 0xd800 && chCode <= 0xdbff && i + 1 < str.length) {
      ch = str.slice(i, i + 2);
      step = 2;
    } else {
      ch = str[i];
      step = 1;
    }
    let w = 1;
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x1100 && cp <= 0x11ff) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000) ||
      (cp >= 0x2600 && cp <= 0x27bf)
    ) {
      w = 2;
    }
    if (visible + w > maxWidth - suffix.length) {
      result += suffix;
      break;
    }
    result += ch;
    visible += w;
    i += step;
  }
  return result;
}
```
