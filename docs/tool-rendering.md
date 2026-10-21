# Tool Rendering in Pi

How `renderCall` and `renderResult` work under the hood, and how to avoid the most common visual glitches when overriding built-in tools or writing custom ones.

## How a tool row is built

Two independent decisions, routinely confused:

1. **Who draws the frame** — `renderShell`. `"default"` (the default) has Pi draw the colored box
   (pending → success/error background) around your component. `"self"` gives you a bare container
   with **no background** — you paint everything, bg included.
2. **What goes in the row** — `renderCall` (header) and `renderResult` (body). **Any piece you do not
   provide is silently filled from Pi's built-in renderer for that tool name.**

They are independent: `renderShell` never changes *which* renderers run, and the built-in merge
happens the same way at `"default"` and `"self"` (verified 2026-10-04 by calling `withBuiltInRenderers`
on 1.0.1 — a `"default"` and a `"self"` override that omit `renderResult` both come back with the
built-in `edit` result renderer attached).

```ts
pi.registerTool({
  name: "edit",
  renderShell: "self",      // you own the frame — paint the bg yourself
  // renderShell: "default" // Pi draws the colored Box; return plain components
});
```

### Duplicates and the JSON dump

The 0.83-era "duplicate block" glitch — a stray built-in header, or a wall of `JSON.stringify(args)`
for params the built-in does not know (e.g. `multi[]`) — is **not** caused by `renderShell`. It comes
from an override that supplies `renderCall` but **not** `renderResult` (or vice versa): Pi merges the
missing piece from the built-in renderer for that name, and that body does not understand the custom
args. Fix it by supplying the missing renderer, not by switching `renderShell`.

## The two patterns (pick one per tool)

| Pattern | When | `renderShell` | `renderCall` | `renderResult` |
|---|---|---|---|---|
| **A — Pi frames** | a new tool name, or an override whose result keeps the built-in shape | `"default"` | your plain component (no `Box`, no bg) | omit to inherit the built-in body, or supply your own |
| **B — you frame** | an override whose schema/result differs from the built-in (custom `edit`) | `"self"` | your component, paint the bg with pi-tui `Box`/`Text` + `bgFn` | yours — the bare container paints no bg, so an inherited built-in body would half-render |

Both patterns still require: never hand-pad strings to terminal width (`Box`/`Text` pad safely), and
keep the body height stable during `isPartial` (a 0 → N jump makes the TUI flash).

### Live overrides audited against these patterns (2026-10-04)

| Extension | Tool | Pattern | Note |
|---|---|---|---|
| read-mode | `read` | A | `renderCall` only; inherits the built-in `read` body (result keeps the built-in text shape) |
| write-mode | `write` | A | `renderCall` + `renderResult`; native schema, own execute (BOM kept, sized result), one-line row |
| grep-tool | `grep` | A | `renderCall` only; inherits the built-in `grep` body |
| context-guard | `bash` | A | `renderCall` only (+ timer frozen at settle); `execute` delegates to `createBashToolDefinition` |
| pi-agent-run | `pwsh`, `py` | A | new names; no built-in renderer exists. Own `renderCall` + `renderResult`; timer frozen at settle, Ctrl+O lifts the command cap *and* the 120-column clip |
| sub-agents | own name | A | own `renderCall` + `renderResult` |
| web-search-st | 2 own names | A | own `renderCall` + `renderResult` |
| pi-multi-edit | `edit`, `multi_edit`, `insert` | B | schema differs from native `edit`; paints its own bg |

Only pattern B needs `renderShell: "self"`; every other override correctly stays on `"default"`.

### 1.0.1 internals (why "no registry" is a red herring)

`interactive-mode.js` resolves a row's renderers as
`resolveToolRenderers(toolName, () => withBuiltInRenderers(toolName, getToolDefinition(toolName)))`.
`withBuiltInRenderers` lives in `core/tools/renderers/index.js` — **the name-keyed registry**
(`read, bash, powershell, edit, write, grep, find, ls`) — and fills each renderer the registered
definition omits; then extension `registerToolRenderer` resolvers run in load order.
`ToolExecutionComponent` only reads the finished result (`renderShell ?? "default"` picks `contentBox`
vs `selfRenderContainer`); it no longer does the name lookup itself, which is why a naive read of that
file "finds no registry". The registry is real and still merged in — it just moved up a level.

For calls whose tool is **not registered** (resumed sessions, a disabled or archived extension, MCP
tools), the same `resolveToolRenderers` falls back to the built-in renderers alone. Since 0.99 such
calls at least print their arguments as `key=value`; before that they were raw JSON.
`pi.registerToolRenderer((toolName, next) => …)` (1.0.1) is the hook to draw them properly — see
`docs/pi-update-check.md` §5 for the pending smoke list.

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

Both outputs are stacked vertically.

**Background (verified against 0.80.7 and 0.83.0):** the outer `selfRenderContainer` paints **no background**. Pi only applies the pending/success/error `bgFn` to the default-shell `contentBox` (`tool-execution.js` `updateDisplay()` applies `setBgFn` only when the container is a `Box`). If you want the colored block with `renderShell: "self"`, paint it yourself with pi-tui `Box`/`Text` — this is exactly what the built-in `edit` renderer does (`dist/core/tools/edit.js`: `Box(1, 1)` + `setBgFn(theme.bg("toolPendingBg"/"toolSuccessBg"/"toolErrorBg"))`).

State for the bg color is derivable in every render call (Pi re-invokes both renderers on each `updateDisplay`):

```ts
const state = (options?.isPartial ?? context?.isPartial ?? true)
  ? "toolPendingBg"
  : context?.isError ? "toolErrorBg" : "toolSuccessBg";
```

Never pad strings manually to fake the background (width miscounts crash the TUI) — `Box`/`Text` pad to width safely. Working implementation: `pi-multi-edit/render.ts` (`makeCallComponent` / `makeResultComponent`, added 2026-08-02).

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
- Do **not** return `[]` during partial: it collapses the block to zero height and the 0 → N jump flashes the buffer (§3 below). `[""]` (one empty string) keeps the height at 1 line but can leave a ghost line. **Use a single static placeholder line** (a space alone is not enough — use a visible glyph) so the height never starts at zero.

**Confirmed working pattern for partial:**

```ts
renderResult(result, options, theme, context) {
  if (options.isPartial) {
    return { render(_w: number) { return ["…"]; }, invalidate() {} };
  }
  // ...
}
```


## Where the row's arguments come from (and when they are stale)

`renderCall` is not called once with finished arguments — it is called on **every stream delta**, and
the arguments it gets are whatever the provider has delivered so far.

- The row is created on the first `message_update` whose message contains the toolCall block — i.e.
  when the **name** arrives, before a single byte of arguments. At that point `args` is `{}`.
- Each later delta calls `updateArgs(content.arguments)`, which is
  `parseStreamingJson(accumulatedArgumentString)` — a partial parse, so values are **prefixes**: a key
  exists as soon as the model emits it, a string value grows character by character. Field order in
  that object is the model's emission order.
- Pi never refreshes the arguments afterwards: `tool_execution_start` **discards `event.args`** when
  the row already exists, and `message_end` only sets `argsComplete` (no argument update). A row whose
  last streamed delta stopped short of the JSON tail therefore keeps those partial arguments forever,
  and the settled row renders them.

So: never assume a field will be there during the stream, and do not read a missing field as an error.
If your renderer needs the *final* arguments (a path, a count, a diff base), capture them where they
are authoritative — the tool's own `execute(toolCallId, params, …)` — key them by `toolCallId`, prefer
them in `renderCall`, and drop them in `renderResult`. `write-mode` does exactly this; a row whose
tool-call id never matched (a gateway mutating ids mid-stream leaves a stale row behind) falls back to
a content-prefix match against the last executed calls.

`context.args` inside `renderResult` is the same possibly-stale object. `context.state` is one object
per row, shared by the call and result slots — the place for a timer, a cached stat, or a resolved
path.

### Key order is the model's, not the schema's

Measured on this host (2026-10-05): with **one** tool in the request the model follows the schema's
declared property order; with a realistic **15-tool** request the order goes unstable for the same
schema (`marker,path,content` → `marker,content,path` → `content,marker,path`), and `strict: true`
changes nothing because the gateway applies no grammar. Wording hints in the parameter description do
not move it either (17% path-first over 51 writes against an 18–22% baseline). Consequence for a
renderer: a field you would like early (`path` for `write`, `new_string` for `edit`) may arrive last or
never during the stream. Design the row to be readable with the fields that exist, and let the
liveness signal (a 1 Hz clock, a growing count) carry the rest.

### Delta granularity is the provider's, not the renderer's

"The row fills in smoothly" is a property of the API, not of `renderCall`:

| Provider / API | Measured behaviour |
|---|---|
| `opencode-go` `openai-completions` (deepseek-v4.1-flash) | ~1–2 tokens per delta (150 deltas for 644 B); args arrive progressively |
| `kimi-coding` `anthropic-messages` (k3-256k) | many deltas, `path` last (~14.4 s of a 14.4 s stream) |
| `xai` `openai-responses` (grok-4.6/4.7) | **one** delta for the whole call — a 7 KB write pops in complete, nothing to animate |
| `opencode-go` with `kimi-k3` (2026-08) | 2 deltas — name, then the whole argument dump |

A renderer cannot make a one-delta provider stream, and a clock is the only honest signal during a
provider's silence. Do not "fix" a jumping row before checking the delta count.

**Short arguments look like a pop even on a chatty provider.** A row is created on the first delta and
re-rendered on each one (`message_update` → `updateArgs(content.arguments)` → `renderCall`; there is no
gate on completed arguments), so what you see is purely how many bytes arrive per delta *and* how long
the whole call takes. From the v1 `stream-tool-log` timeline (2026-08-05, 511 calls): `bash` on
`opencode-go/deepseek-v4-flash` streamed a median of **72 deltas over 639 ms** (max 2.1 s) while a
single `write` took **3275 deltas over 26.9 s**; `bash` on `xai/grok-4.5` was **1 delta, always**
(median span 208 ms). The command row therefore reads as instant on every provider — chatty ones
finish before the eye registers growth, xAI genuinely dumps — while the same renderer on `write` shows
15–27 s of visible growth. Do not read the difference as a streaming bug in either row.

### Measuring this without the TUI

- `stream-tool-log` (`/streamlog on`) records the live timeline per tool call: `d` (delta count),
  `pathAt` / `contentAt` (ms until a field became non-empty), `emptyMs`, and a verdict
  (`provider_buffer` / `progressive` / `header_late`). Start here.
- Session JSONL holds the final arguments only — enough for per-model key-order statistics (the
  `content`-before-`path` rate, per tool), not for timing.
- A gated trace inside the extension is the sharpest instrument: `write-mode`'s `PI_WRITE_TRACE=1`
  appends one JSON line per call render and per execution (`src` = `final` / `stream` / `match`, keys,
  path, content length, phase flags) to `~/.pi/agent/logs/write-mode-trace.jsonl`. Copy that pattern
  when a row misbehaves.

### Renderer harness: the real agent loop, no TUI

A renderer can be driven end-to-end with the real provider and the real event sequence, without Pi's
TUI (this is how the stale-argument behaviour above was confirmed):

```js
// throwaway agent dir: copies of auth.json / models.json / settings.json, never the live one
process.env.PI_CODING_AGENT_DIR = temp;
const { loadExtensions } = await import(pkgRoot + "/core/extensions/loader.js");
const tool = (await loadExtensions([extPath], cwd)).extensions[0].tools.get("write").definition;

const { createAgentSession, ModelRuntime, SessionManager } = await import("@earendil-works/pi-coding-agent");
const model = (await ModelRuntime.create({ refreshOnCreate: false })).getModel("opencode-go", "deepseek-v4.1-flash");
const { session } = await createAgentSession({ model, tools: ["write"], customTools: [tool], sessionManager: SessionManager.inMemory() });
// subscribe, then mimic interactive-mode.js: updateArgs → renderCall(args, theme, ctx) → .render(200)
```

Two traps: pass the definition as `customTools` (a second copy of the module has its **own** module
state, so `execute` and the renderer would not share the `finalArgs` map), and if you copy extensions
into the throwaway dir, copy the role files too — otherwise `role-sw` leaves `SYSTEM.md`'s canary in
place and every model replies `РАНТАЙМ СЛОМАН: нет роли.`

## Native built-in expectations

The inheritance is by **name**, and a built-in result renderer may depend on state that only its own
`renderCall` sets. Only two built-ins carry such state: `bash` (`context.state.startedAt` → the
`Elapsed` / `Took 2m 12s` line) and `edit` (`context.state.callComponent`, the diff highlight cache).
A call-only override of `bash` therefore inherits a body that can no longer print the duration at all —
the live symptom is a timer that ticks while the command runs and vanishes the moment it settles
(14.8% of 12 151 bash rows ran ≥ 5 s). Two ways out: seed the state you inherit (`context.state.startedAt`),
or own the duration yourself under a **namespaced** key — the shared state object is one object per row,
so writing `startedAt` at the top level switches the inherited line back on and duplicates it.
`edit` is safe today only because `pi-multi-edit` supplies both renderers. Both fixes were verified by
rendering the real renderer pairs against one shared state object outside the TUI (2026-10-05).

If you **do not** provide `renderCall` / `renderResult`, Pi falls back to the **built-in** renderer for that tool name (e.g. `edit`).

The native `edit` renderer expects:
- Tool arguments shaped as `{ path, edits: [{oldText, newText}] }`
- `details.diff` in **unified diff** format (`@@` headers, `+`/`-` lines)

If your custom `edit` uses a different schema (for example the current `pi-multi-edit` extension uses `old_string`/`new_string` and a separate `multi_edit` tool), the native renderer will mis-parse the diff and may show duplicated or broken output. Always provide custom renderers when you change the argument schema.

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

## Expanded state (`Ctrl+O`)

The user can toggle tool output open/closed with **Ctrl+O** (or by clicking the tool block). `renderResult` receives this state in `options.expanded`.

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

### `truncateToWidth` pitfalls

Measured against the **installed** pi-tui (1.0.1, `dist/utils.js:1018`, re-checked 2026-10-06): it
grapheme-segments the non-ASCII path and extracts ANSI, so Cyrillic (`проверка ширины строки…`) and
emoji (`deploy 🚀🚀🚀 to prod`) truncate **without corruption** and within width at 20/12 columns. The
older warning about UTF-8 corruption applied to the code-unit slicing of an earlier version — re-check
before writing a workaround for it.

What is still true: every **truncated** line ends as `\x1b[0m…\x1b[0m` (full SGR reset around the
ellipsis, `finalizeTruncatedResult`). Pi's Box paints the block background by wrapping the whole line
in a bg color, so that mid-line reset wipes the background from the ellipsis to the right edge — the
"torn background" glitch that appears only on lines longer than the preview limit. If all styling in
the line is fg/bold-only, downgrade the reset after truncating:

```ts
const line = truncateToWidth(raw, width).replaceAll("\x1b[0m", "\x1b[22m\x1b[39m");
```

(`\x1b[22m` = bold off, `\x1b[39m` = default fg; the Box background survives.) Used in
`pi-agent-run/render.ts` — **still required**, not a legacy workaround.

**Same mechanism, second source: the child process's own output.** `theme.bg(token, line)` is one wrap
(`<bg>line\x1b[49m`), so *any* mid-line `\x1b[0m` tears it, wherever it came from. Shell output
carries them: PowerShell emits SGR even with `-OutputFormat Text` (measured 2026-10-06:
`\x1b[32;1mProcessId : \x1b[0m6040`, CRLF endings), and `colorama`/`rich`/`pytest` do the same under
Python. A custom `renderResult` must strip them before styling, exactly as Pi's own body does
(`getTextOutput` in `core/tools/render-utils.js`: `stripAnsi` → `sanitizeBinaryOutput` → CR strip).
Skip it and the row breaks twice over: everything right of the child's reset — usually the whole value
column — draws on the terminal's own background ("black, half-filled row"), and a raw CR splits the
line a second time inside `Text` → `wrapTextWithAnsi` (which splits on `/\r\n|\r|\n/`), leaving one
stray empty row per CRLF line. `pi-agent-run` owns the only live row that needed this
(`sanitizeProcessOutput`, 2026-10-06); inherited built-in bodies were already covered.

**Safe replacement** that counts only visible characters and preserves ANSI — canonical implementation
in `docs/patterns.md` §"Safe truncation for custom renderers"; the examples below call it. Note that no
live extension needs it: rows built from pi-tui `Text`/`Container` wrap safely on their own, and the
only hand-built line array (`pi-agent-run`) uses `truncateToWidth` plus the reset downgrade above.

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
  context.state;             // one object per row, shared with renderResult
  context.invalidate();      // force re-render
}

renderResult(result, options, theme, context) {
  options.isPartial;         // still streaming?
  options.expanded;          // user toggled Ctrl+O?
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
  renderShell: "self",   // pattern B: owns the frame (see "The two patterns")

  renderCall(args, theme) {
    const mode = Array.isArray(args.multi) ? "multi" : "";
    const modeLabel = mode ? `edit:${mode}` : "edit";
    const path = args.path || "...";
    const label = `${theme.fg("toolTitle", theme.bold(modeLabel))} ${theme.fg("accent", path)}`;
    return makePlainText(label);
  },

  renderResult(result, options, theme, context) {
    if (options.isPartial) {
      return makePlainText(" "); // one stable line: fixed height, no 0 → N flash
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
1. `renderCall` + `renderResult` are both required **when your result shape differs from the built-in** — supplying only one makes Pi merge the built-in for the other, which is the real source of duplicates (not `renderShell`).
2. `renderCall` = header only (`edit:batch path (count)`).
3. `renderResult` = body only (diff lines or error text). Never repeat the header.
4. Partial phase must keep height fixed — return one static placeholder line, not `[]` (a 0 → N jump flashes; see §3).

## Battle-tested lessons from `pi-multi-edit` (2026-06)

After ~15 iterations trying to get a custom `edit` override stable, the following **hard-earned** rules emerged.

### 1. A custom `edit` needs both renderers (the real lesson)

The built-in `edit` renderer **always** exists as a fallback and is merged into any override that
omits a piece. With `renderCall` supplied but `renderResult` missing you get:
- **Duplicate blocks** (your header + the built-in header/diff block).
- **Giant JSON dump** — the built-in header does `JSON.stringify(args, null, 2)` for unknown params
  like `multi[]`; it flashes for 1–2 frames before collapsing.
- **Orphaned "edit" headers** — the built-in header drawn below yours.

**Verdict:** supply **both** `renderCall` and `renderResult` whenever the custom `edit` schema differs
from the native `{path, edits:[{oldText,newText}]}` — that is what stops the merge. `renderShell:
"self"` is only about who paints the frame (pattern B), not about the merge; the 2026-06 note blamed
it, and the blame was wrong (corrected 2026-10-04).

### 2. Do NOT manually apply `theme.bg()` + width padding

We tried padding every line to terminal width and wrapping in `theme.bg("toolSuccessBg", ...)` to fill the Box background manually. This caused:
- **TUI glitches on every state change** (pending → success, Ctrl+O expand/collapse).
- **Missing background colors** — the padded spaces sometimes rendered as black holes.
- **Crash risk** — miscounting visible width with ANSI sequences = `Rendered line N exceeds terminal width`.

**Verdict (updated 2026-08-02):** the warning above applies to **manual string padding**, not to pi-tui components. In current runtimes the `selfRenderContainer` paints no background at all, so with `"self"` you get plain text unless you paint bg yourself. The safe way is `Box(1, 1, bgFn)` / `Text(text, 1, 0, bgFn)` from `@earendil-works/pi-tui` with `bgFn = (s) => theme.bg(token, s)` — the same components Pi's built-in `edit` renderer uses. Do not hand-pad with `" ".repeat(width)`.

### 3. `renderResult` must return stable height during partial

Returning `[]` (empty array) during `options.isPartial` collapses the block to zero height. When the result arrives, the block jumps from 0 → N lines. This jump triggers Pi's diff renderer to flash old buffer content for 1–2 frames (the "giant text flash" glitch).

Returning `[""]` (one empty string) keeps the block at exactly 1 line during partial, making the transition smoother. However, it can leave a ghost line artifact.

**Best compromise found:** return a single static placeholder line (e.g. a space or the header repeated) during partial, so height never changes.

### 4. Large-file diffs (>1000 lines) always glitch on expand/collapse

Even with `clampDiff(diff, 50)` limiting output to 50 lines, if the underlying file is large, Pi's TUI still seems to allocate/render a larger internal buffer. Toggling `Ctrl+O` causes a massive text flash before settling.

**Verdict:** If you need glitch-free display for large files, **do not render diffs at all** inside `renderResult`. Show only a one-line summary.

### 5. The only bulletproof solution: use a custom tool name

`pi-xai-oauth` avoids all of this by registering **new** tool names (`StrReplace`, `Edit` with capital E) instead of overriding the built-in `edit`. Custom tool names have **no built-in renderer**, so:
- `renderShell: "default"` works perfectly — Pi draws the Box, no fallback conflicts.
- No JSON-dump flash.
- No duplicate blocks.

**If visual stability matters more than the model calling `edit` by name**, this is the only path that "just works."

### 6. Minimal stable override pattern (if you must keep `name: "edit"`)

If you absolutely need to override the built-in `edit` and want the least-glitchy display:

```ts
pi.registerTool({
  name: "edit",
  renderShell: "self",

  renderCall(args, theme) {
    // ONE line, never fails, no heavy logic
    const label = theme.fg("toolTitle", theme.bold("edit")); // or edit:batch etc.
    return {
      render(width: number) { return [safeTruncate(label, width)]; },
      invalidate() {},
    };
  },

  renderResult() {
    // Dead-empty.renderCall already showed everything.
    return { render() { return []; }, invalidate() {} };
  },

  async execute(...) { /* ... */ }
});
```

What you get: a stable 1-line block (`edit:batch path.js (3 changes)`) that turns from blue → green without content jumps. No diff, no summary, no glitches. Whether this UX is acceptable depends on your workflow.

## See also

- `docs/off-doc-llm/EXTENSIONS.md` — full ExtensionAPI reference
- `docs/patterns.md` — snippets for commands, events, components
- `node_modules/@earendil-works/pi-coding-agent/examples/extensions/built-in-tool-renderer.ts` — official override example
