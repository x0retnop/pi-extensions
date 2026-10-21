# read-mode

Mode-aware override of the built-in `read` tool.

## Important behaviors

- Supports images (PNG, JPG, GIF, WebP, BMP) in raw mode.
- If `mode: "raw"` is used with a `target`, it auto-switches to `mode: "section"`. The model-facing description does not mention this. Do not put "do not pass target in raw" back — that sentence was false; the auto-switch is the safety net.
- Block detection: braces (JS/TS/C#/C++/…), Python indentation, language-specific `end` where wired. Markdown/HTML: next heading of the same or higher level.
- Markdown (`.md`/`.mdx`): ATX `#`…`######`. Headings inside ` ``` ` / `~~~` fences are not structure; a section still includes the fence body. Closed ATX (`## Foo ##`), `{#id}`, and `[text](url)` headings expose the plain name.
- HTML (`.html`/`.htm`): same-line `<h1>`…`<h6>` only (inner text, or `id` if the tag is empty). No DOM parser — multiline headings, `<div id>`, minified one-liners are `raw`/grep.
- Overview lines are `[line N] <type> <name>` (type included for skimming).
- C# / C++ parsers require real signatures (access modifiers / return types / `Type::method`); call-sites are not listed. C++ out-of-line names appear as `Class::Method`; section accepts bare or qualified targets.
- Python: `async def` counted; `mode:section` expands upward to include `@decorators` (incl. multi-line args).
- JS/TS: `export default function` (named → name, anonymous → `default`); column-0 / `export const fn = … =>` included; nested `const` helpers are not.
- Rust: `pub(crate)` / `pub(super)`, `async fn`, `mod`, `impl Trait for Type` (section target accepts `Trait for Type` or bare type).
- `overview` / `section` are structure-based: files with no named entities (plain scripts, configs, logs, data, plain text) return `No recognizable structure found` / `Section "..." not found` — use `raw` for those.
- Output is truncated to an internal byte limit with continuation hints.
- For project-wide search, use the separate `grep` tool.

## Rendering

- The call line **is** the row: the built-in result body of `read` prints nothing for a successful read
  until Ctrl+O (`formatReadResult` returns `""` collapsed) and prints text only for errors. That is why
  every failed read returns `isError: true` — the row turns error-colored and shows the message
  (`Section … not found`, offset past EOF, unknown mode, missing target) without expanding. Informational
  results stay non-errors: "no recognizable structure", "multiple matches" candidates, truncation.
- The line is a pi-tui `Text`, so a long path or a long target **wraps** at any width. It used to be a
  hand-built one-liner truncated at the terminal width, which dropped `target=` / `offset=` / `limit=`
  first — the row's own facts, with Ctrl+O unable to bring them back.
- The mode shown is the one that runs: `raw` + `target` executes section, so the row reads `read:section`.
- Images go through the built-in **definition** with the session context, so the path resolves against
  `ctx.cwd` (not the directory Pi was launched in) and the model's image resize limits apply.
