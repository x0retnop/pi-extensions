# Pi Extension Gotchas

Hard-earned practical notes for writing Pi extensions. Supplements `tool-rendering.md`; the API reference is `docs/off-doc-llm/EXTENSIONS.md`.

## Tool text the model never sees

This host always loads a role (`role-sw`), which sets a custom system prompt. Pi then skips its default tool list. `promptSnippet` and `promptGuidelines` do not reach the model. What does: `description` and each parameter's `description`. Cross-tool policy goes in the role file, not in those skipped fields. Do not put a call rule only in the role either — another role, or a session with no role, never sees it. Details: `docs/extensions/role-sw.md`, `docs/pi-tool-internals.md` §3.

## `ToolRenderContext` is not exported from the main package

`@earendil-works/pi-coding-agent` exports `ToolDefinition`, `ToolRenderResultOptions`, etc., but **not** `ToolRenderContext` from its top-level index. Deep-importing it from `dist/core/extensions/types` also fails under `NodeNext` module resolution.

**Workaround:** infer the context type from `ToolDefinition["renderResult"]`:

```ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type ToolRenderCtx = Parameters<
  NonNullable<ToolDefinition["renderResult"]>
> extends [unknown, unknown, unknown, infer C] ? C : never;
```

Then use it in your renderer signature:

```ts
function renderResult(
  result: AgentToolResult<MyDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderCtx,
) { /* ... */ }
```

## `AgentToolResult` has no `isError` field

Do not check `result.isError`. The result object returned by `execute()` only contains:

```ts
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  addedToolNames?: string[];
  terminate?: boolean;
}
```

Whether the tool failed is available **only** in the render context:

```ts
renderResult(result, options, theme, context) {
  if (context.isError) {
    // execute() threw or returned isError: true via event
  }
}
```

## Always pair `renderCall` with `renderResult` for custom tools

A tool registered with `renderCall` but no `renderResult` falls back to Pi's generic result body: the
first 10 lines of `result.content[0].text` (`FALLBACK_PREVIEW_LINES` in `tool-execution.js`), each line
fg'd `toolOutput`, then `... (N more lines, <key> to expand)`. It does respect `expanded`, but the cap
is not yours and the *head* is what you get — for a guarded run that is the top of the kept tail, with
the spill path below the cut. A **new** tool name has no built-in renderer to merge either, so the
fallback is the whole body (see `pi-agent-run` before 2026-10-06).

Pattern that works:

```ts
pi.registerTool({
  name: "my_tool",
  renderShell: "self",

  renderCall(args, theme) {
    return new Text(theme.fg("toolTitle", theme.bold("my_tool")) + " ...", 0, 0);
  },

  renderResult(result, options, theme, context) {
    // body only, no header duplication
    return makeTextComponent([...], theme);
  },

  async execute(...) { /* ... */ },
});
```

## A component can be a plain object

Pi only duck-types components. You do not need to import `Text`/`Container` from `pi-tui`:

```ts
function makePlainText(text: string) {
  return {
    render(_width: number) { return text ? [text] : []; },
    invalidate() {},
  };
}
```

Useful when you need custom width handling (e.g. Unicode/wide-char truncation) that `Text` does not provide.

## Truncate every rendered line

Pi TUI crashes with `Rendered line N exceeds terminal width` if any line is wider than the viewport.

- For ASCII with ANSI: use `truncateToWidth` from `@earendil-works/pi-tui`.
- For mixed ASCII/ANSI + wide Unicode (CJK, emoji): use a `safeTruncate` that skips ANSI sequences and counts East-Asian width.

Canonical implementation (tab/CR-normalized, surrogate-pair and wide-char aware): `docs/patterns.md` §"Safe truncation for custom renderers".

## `renderCall` and `renderResult` receive the same args object

`ToolRenderContext.args` contains the validated tool arguments. It is stable across call and result renders, so you can access params in `renderResult` without re-parsing `content.text`.

```ts
renderResult(result, options, theme, context) {
  const params = context.args as MyParams;
  // params.output_mode, params.pattern, etc.
}
```

## `renderResult` runs for partial updates too

`options.isPartial === true` while the tool is still executing. Return a small placeholder to avoid height jumps:

```ts
renderResult(result, options, theme) {
  if (options.isPartial) {
    return makePlainText(theme.fg("warning", "Running..."));
  }
  // ...
}
```

## Store structured data in `details`, not just text

`result.details` is the right place to pass structured rendering data from `execute()` to `renderResult()`. Keep `content.text` as the LLM-facing summary and put machine-readable fields (matches, paths, counts, flags) into `details`.

Example:

```ts
return {
  content: [{ type: "text", text: "3 matches in 2 files" }],
  details: {
    matches: [{ file: "a.ts", line_number: 12, content: "..." }],
    count: 3,
    total: 3,
    truncated: false,
  },
};
```

## Be careful with `details` types

TypeScript cannot enforce runtime shape. A field like `details.files` may be `string[]` in one branch and `number` in another. Normalize before rendering:

```ts
const fileCount = Number(details.files ?? 0);
```

## Avoid `finally` cleanup that depends on formatted details

If you generate a temp file path inside `formatResult()` and need to clean it up later, do not rely on `finally` reading `result.details` before it exists. Store the path only after formatting completes:

```ts
const formatted = await formatResult(result, ...);
result.details = { fullOutputPath: formatted.details?.fullOutputPath };
return formatted;
```

Or clean up via a `tool_result` event / session shutdown hook.

## Custom tool names avoid renderer conflicts

The built-in renderer for a name (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) is merged into any override of that name that omits `renderCall`/`renderResult` — this, not `renderShell`, is what produces duplicate blocks. Overriding a built-in whose result keeps the built-in shape is fine: supply `renderCall` and let the built-in body stand in (read-mode, grep-tool, context-guard). When the schema/result differs (custom `edit`), supply both renderers. A **new** tool name has no built-in renderer at all, so it can never conflict. See `docs/tool-rendering.md` §"The two patterns".

## `renderShell: "self"` does not give you the colored box

With `renderShell: "self"` Pi hands you a bare container that paints **no** background — you get plain text unless you paint the bg yourself with pi-tui `Box`/`Text` and `bgFn = (s) => theme.bg(token, s)`. Pi only applies the pending/success/error background to the default-shell `contentBox`. Never hand-pad lines to terminal width — that causes black holes and `Rendered line N exceeds terminal width` crashes; `Box`/`Text` pad safely.

## See also

- `docs/tool-rendering.md` — full renderCall/renderResult guide
- `docs/off-doc-llm/EXTENSIONS.md` — ExtensionAPI reference (owner)
- `docs/pi-tool-internals.md` — tool visibility and setActiveTools timing
