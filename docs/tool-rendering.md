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

## Native built-in expectations

If you **do not** provide `renderCall` / `renderResult`, Pi falls back to the **built-in** renderer for that tool name (e.g. `edit`).

The native `edit` renderer expects:
- Tool arguments shaped as `{ path, edits: [{oldText, newText}] }`
- `details.diff` in **unified diff** format (`@@` headers, `+`/`-` lines)

If your custom `edit` uses a different schema (`multi`, `patch`, or `File:` prefixed diffs), the native renderer will mis-parse the diff and may show duplicated or broken output. Always provide custom renderers when you change the argument schema.

## Theme colors commonly used

```ts
theme.fg("toolTitle",   theme.bold("edit"))   // tool name
theme.fg("accent",      path)                  // file path / subject
theme.fg("dim",         "(3 changes)")         // meta suffix
theme.fg("toolDiffAdded",   "+5")              // diff stats
theme.fg("toolDiffRemoved", "-2")
theme.fg("error",       errText)               // failures
```

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

## Minimal working example

```ts
function makePlainText(text: string) {
  return { render(_w: number) { return text ? [text] : []; }, invalidate() {} };
}

pi.registerTool({
  name: "edit",
  label: "edit",
  renderShell: "self",

  renderCall(args, theme) {
    const path = args.path || "...";
    return makePlainText(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}`);
  },

  renderResult(result, options) {
    if (options.isPartial) return makePlainText("");
    const diff = result.details?.diff;
    if (diff) return { render(_w: number) { return diff.split("\n"); }, invalidate() {} };
    return makePlainText("");
  },

  async execute(...) { /* ... */ }
});
```

## See also

- `docs/pi-quickref.md` — full ExtensionAPI reference
- `docs/patterns.md` — snippets for commands, events, components
- `node_modules/@earendil-works/pi-coding-agent/examples/extensions/built-in-tool-renderer.ts` — official override example
