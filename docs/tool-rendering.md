# Tool Rendering in Pi

How `renderCall` and `renderResult` work under the hood, and how to avoid the most common visual glitches when overriding built-in tools or writing custom ones.

## renderShell modes

```ts
pi.registerTool({
  name: "edit",
  renderShell: "self",   // tool renders its own framing
  // renderShell: "default"  // Pi wraps output in a colored Box
})
```

- `"default"` — Pi draws a colored shell (pending / success / error background) and places your component inside it.
- `"self"` — Pi skips its shell and puts **your** component directly into the chat stream. You are responsible for header + body, but you also control the layout completely.

### Critical: built-in tool overrides

If you override a **built-in** tool (e.g. `edit`, `bash`) and use `renderShell: "default"`, Pi may still invoke the **native fallback result renderer** for that tool name. This produces **duplicate blocks**: one from your `renderCall` (inside the colored box) and another from the built-in renderer (below it, often with a different background).

| Tool | `renderShell: "default"` safe without `renderResult`? | Notes |
|---|---|---|
| `read` | ✅ Yes | No built-in diff renderer; Pi shows plain text fallback. |
| `edit` | ❌ No | Built-in `edit` renderer draws its own header + diff block, causing duplicates. |
| Custom tool names | ✅ Yes | No built-in renderer exists. |

**Rule:** when overriding `edit` (or any built-in that has a native diff renderer), always use `renderShell: "self"` and provide **both** `renderCall` (header) and `renderResult` (body only). This is the only combination that suppresses the fallback completely.

## Component contract (duck-typed)

Pi does **not** require `pi-tui` classes. A plain object works:

```ts
function makePlainText(text: string) {
  return {
    render(_width: number): string[] {
      return text ? [text] : [];
    },
    invalidate() {},
  };
}
```

If you import `Text` / `Container` from `@earendil-works/pi-tui`, you get layout helpers, but they are optional.

## How Pi composes call + result

When `renderShell: "self"`, `ToolExecutionComponent` creates a single `selfRenderContainer` and adds children in this order:

1. `renderCall(args, theme, context)` — always rendered.
2. `renderResult(result, options, theme, context)` — rendered **below** the call as soon as `result` arrives.

Both outputs are stacked vertically. The **outer** container already handles the background color transition (pending → success / error). Your renderers should **not** try to re-create the colored shell.

## The #1 pitfall: header duplication

If `renderCall` prints:
```
edit path.js
```

and `renderResult` also prints:
```
Applied 2 edits successfully.
```

The user sees **two summary lines** with different backgrounds (pending vs success), creating the illusion of a "double" tool execution.

**Correct pattern:**

| Renderer | Responsibility |
|---|---|
| `renderCall` | **Header only**: tool name + target path + optional arg summary |
| `renderResult` | **Body only**: diff, error details, or nothing. Never repeat the header. |

Example:

```ts
renderCall(args, theme, _ctx) {
  const label = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", args.path)}`;
  return makePlainText(label);
},

renderResult(result, options, _theme, _ctx) {
  if (options.isPartial) {
    return makePlainText(""); // empty while running
  }
  const diff = result.details?.diff;
  if (diff) {
    return makeWrappedText(diff.split("\n"));
  }
  return makePlainText("");
}
```

## Partial / streaming state

- `options.isPartial === true` while the tool is still executing.
- `renderResult` is called on **every** update, so keep it cheap.
- Return an empty component (`[]`) during partial phase if you do not want any placeholder text.

**Confirmed working pattern for partial:**

```ts
renderResult(result, options, theme, context) {
  if (options.isPartial) {
    return { render(_w: number) { return []; }, invalidate() {} };
  }
  // ...
}
```

Returning `[""]` or `makePlainText("")` during partial can leave a ghost line or trigger Pi's `"⚡ Working..."` fallback. An empty array `[]` is the only safe value.

## Native built-in expectations

If you **do not** provide `renderCall` / `renderResult`, Pi falls back to the **built-in** renderer for that tool name (e.g. `edit`).

The native `edit` renderer expects:
- Tool arguments shaped as `{ path, edits: [{oldText, newText}] }`
- `details.diff` in **unified diff** format (`@@` headers, `+`/`-` lines)

If your custom `edit` uses a different schema (`multi`, `patch`, or `File:` prefixed diffs), the native renderer will mis-parse the diff and may show duplicated or broken output. Always provide custom renderers when you change the argument schema.

### Diff format for custom `renderResult`

When you provide a custom `renderResult` for `edit` (with `renderShell: "self"`), you control coloring manually. The diff format should match what your renderer expects:

- **Single-file edits** — return plain unified diff (no `File:` prefix). Your `renderResult` can add its own filename context if needed.
- **Multi-file edits** — prefix each file's diff with `File: <path>` so `renderResult` can parse and colorize per-file sections.

Example:
```ts
// Single file
return { diff: unifiedDiffString };

// Multi file
return { diff: "File: src/a.ts\n" + diffA + "\n\nFile: src/b.ts\n" + diffB };
```

## Diff colors reference

Pi defines three dedicated diff colors in every theme:

| Token | Used for |
|---|---|
| `toolDiffAdded` | Added lines (`+`) and addition stats |
| `toolDiffRemoved` | Removed lines (`-`) and removal stats |
| `toolDiffContext` | Context lines, `@@` headers, `---` / `+++` filenames |

```ts
// Manual coloring for unified diff
diff.split("\n").map((line) => {
  if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
  if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
  return theme.fg("toolDiffContext", line);
});
```

Other commonly-used colors:

```ts
theme.fg("toolTitle",   theme.bold("edit"))   // tool name
theme.fg("accent",      path)                  // file path / subject
theme.fg("dim",         "(3 changes)")         // meta suffix
theme.fg("error",       errText)               // failures
```

## Expanded state (`Ctrl+E`)

The user can toggle tool output open/closed with **Ctrl+E** (or by clicking the tool block). `renderResult` receives this state in `options.expanded`.

**Recommended pattern for diffs:**

| State | Show |
|---|---|
| Collapsed (`!expanded`) | Compact stats only: `+3 / -2` |
| Expanded (`expanded`) | Full colored diff |

```ts
renderResult(result, options, theme) {
  const diff = result.details?.diff;
  if (!diff) return makePlainText("");

  const { additions, removals } = diffStats(diff);
  const header = theme.fg("toolDiffAdded", `+${additions}`)
               + theme.fg("dim", " / ")
               + theme.fg("toolDiffRemoved", `-${removals}`);

  if (!options.expanded) {
    return makePlainText(header);
  }

  // Full colored diff when expanded
  const lines = colorizeDiff(diff, theme);
  return makeWrappedText([header, ...lines]);
}
```

## `renderDiff` — native colored diff renderer

`@earendil-works/pi-coding-agent` exports `renderDiff(diffText)` which produces colored output with intra-line token highlighting.

**Input format:** expects a **numbered** diff where lines start with a prefix, optional line number, and a space:

```
-47 const x = 1;
+47 const x = 2;
 48 return x;
```

**Not** unified diff (`@@` headers) — `renderDiff` looks for lines matching `/^[+\- ]\d*\s/`. If your diff is unified, colorize it manually with `theme.fg("toolDiff*", ...)`.

```ts
import { renderDiff } from "@earendil-works/pi-coding-agent";

const colored = renderDiff(numberedDiff); // string with ANSI sequences
return makeWrappedText(colored.split("\n"));
```

Features:
- **Line-level colors**: green `+`, red `-`, gray context.
- **Intra-line highlighting**: when a single line is replaced (1 removed + 1 added), changed tokens are rendered with inverse video inside the line.

## Terminal width enforcement (critical)

Pi TUI will **crash** with `Error: Rendered line N exceeds terminal width` if any line returned by `render()` is wider than the terminal.

This applies to **all** custom renderers, including `renderShell: "self"` tools and message renderers.

**Do not** return raw strings that may exceed terminal width. Always truncate.

### `truncateToWidth` pitfall

`truncateToWidth` from `@earendil-works/pi-tui` handles ANSI correctly for ASCII, but can corrupt **UTF-8** (e.g. Cyrillic) when ANSI escape sequences are present.

**Safe replacement** that counts only visible characters and preserves ANSI:

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

Use it in every `render(width)` method:

```ts
render(width: number): string[] {
  return lines.map((line) => safeTruncate(line, width, "..."));
}
```

## Override conflicts

If **multiple extensions** register tools with the same name (e.g. `edit`), the **last loaded extension wins**. However, some extensions (like `pi-tool-codex`) may also wrap the tool's renderer if `registerToolOverrides` is enabled for that tool name. This causes visual glitches, duplicated output, or crashes.

**Rule:** if you override a built-in tool with `renderShell: "self"`, ensure no other loaded extension claims ownership of that tool's renderer.

Check `~/.pi/agent/extensions/` for conflicting extensions, or disable the other extension's override via its config.

## renderContext useful fields

```ts
renderCall(args, theme, context) {
  context.toolCallId;        // stable id across call + result
  context.executionStarted;  // true once execute() has begun
  context.argsComplete;      // true when the LLM finished sending args
  context.invalidate();      // force re-render
}

renderResult(result, options, theme, context) {
  options.isPartial;         // still streaming?
  options.expanded;          // user toggled Ctrl+E?
  context.isError;           // result.isError || exception
  context.args;              // same args passed to renderCall
}
```

## Minimal working example (override `edit` safely)

```ts
function makePlainText(text: string) {
  return { render(_w: number) { return text ? [text] : []; }, invalidate() {} };
}

pi.registerTool({
  name: "edit",
  label: "edit",
  renderShell: "self",   // MUST be "self" to suppress built-in fallback

  renderCall(args, theme) {
    const mode = args.patch ? "patch" : Array.isArray(args.multi) ? "multi" : "";
    const modeLabel = mode ? `edit:${mode}` : "edit";
    const path = args.path || "...";
    const label = `${theme.fg("toolTitle", theme.bold(modeLabel))} ${theme.fg("accent", path)}`;
    return makePlainText(label);
  },

  renderResult(result, options, theme, context) {
    if (options.isPartial) {
      return { render(_w: number) { return []; }, invalidate() {} }; // empty, no Working artifact
    }
    if (context.isError) {
      const text = result.content?.[0]?.text ?? "Error";
      return makePlainText(theme.fg("error", text));
    }
    const diff = result.details?.diff;
    if (diff) {
      // Colorize unified diff manually
      const lines = diff.split("\n").map((line) => {
        if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
        if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
        return theme.fg("toolDiffContext", line);
      });
      return { render(width: number) { return lines.map((l) => safeTruncate(l, width)); }, invalidate() {} };
    }
    return makePlainText("");
  },

  async execute(...) { /* ... */ }
});
```

Key takeaways from this pattern:
1. `renderShell: "self"` is **required** for built-in overrides to avoid fallback duplicates.
2. `renderCall` = header only (`edit:batch path (count)`).
3. `renderResult` = body only (diff lines or error text). Never repeat the header.
4. Partial phase returns `[]` (empty array), not `[""]`.

## See also

- `docs/pi-quickref.md` — full ExtensionAPI reference
- `docs/patterns.md` — snippets for commands, events, components
- `node_modules/@earendil-works/pi-coding-agent/examples/extensions/built-in-tool-renderer.ts` — official override example
