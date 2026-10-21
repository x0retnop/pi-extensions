# write-mode

`write` override: Pi's schema, Pi's file semantics, our execution. Name, parameters and constrained
sampling are the native ones, and the write itself still goes through Pi's path resolution, its
per-path mutation queue and its abort checks — so nothing about *where* or *when* a file is written
differs from stock. Two things are ours: the target keeps its BOM, and the result the model reads
carries the size (`persist.ts` header has the census behind both). The row is the other half.

## The row is one line, always

```
write src/app.ts +1.8k, 34 lines · 4s    ← streaming: counts + 1 Hz clock
write ... +1.8k, 34 lines · 4s           ← the model has not emitted `path` yet
write src/app.ts 1.1k → 2.4k, 96 lines   ← settled, overwriting an existing file
write src/app.ts 2.4k, 96 lines          ← settled, new file
```

Height never changes while the call is in flight (no 0→N jump), and the counts come from the partial
args, so they grow as the provider streams. The clock is the liveness signal: it ticks from the moment
the row appears, including the path-less phase, so a stalled stream looks different from a working one.
The interval is cleared the moment the row settles — same pattern as `context-guard`'s bash timer.

Errors are the only body: one red line below the header.

## What the override actually owns

Measured over the same 3 weeks (1071 model-written files, 245 sessions):

- **BOM kept.** 178 of 752 source files in the working repos begin with a UTF-8 BOM — 172 of them
  `.cs` in `mpvi`. Native `write` is a bare `fs.writeFile(..., "utf-8")`, so rewriting one strips the
  BOM and turns a one-line change into a whole-file diff; `edit` has preserved it for months
  (`pi-multi-edit/normalize.ts`), `write` had no way to. `write-mode/persist.ts` re-adds it when the
  target had one and the content does not spell one out itself.
- **Result the model can check.** Native returns `Successfully wrote to <path>` — no size, no
  new-vs-overwrite. It now returns `Wrote src/app.ts — 2.4k chars, 96 lines (overwrote 1.1k)`, the
  same numbers the row shows. Do not sell this as a saved round trip: the model re-reads after a write
  only 2.2% of the time.
- **No new parameters, and none asked for.** Across those 1071 calls the model never passed an
  argument outside `path`/`content` — no `mode`, no `if_exists`, no placeholders in 12 KB files. The
  tool grows nothing until a real failure says otherwise.
- **Line endings stay the caller's.** Zero of the 1071 writes contained CRLF while 137 of the 752 files
  are CRLF, so a rewrite of a CRLF file lands as LF. That is visible in the content the model sent and
  therefore its decision; a BOM is not, which is why only the BOM is restored.
- **The native guideline moves into the description.** Pi's `promptGuidelines` ("Use write only for new
  files or complete rewrites") never reach the model on this host — custom prompt, see
  `docs/pi-tool-internals.md` §3 — so that sentence is appended to `description`.

## The filename appears when the model emits it, and not before

The target is only known once `path` arrives in the streamed arguments, and these models write
`content` first: in a captured session (2026-10-05, `deepseek-v4.1-flash`) the path arrived at +8.0 s
of an 8.1 s stream — 2424 of 2449 renders of that row (99%) had no path, so the row read
`write ... +11.4k, 350 lines · 8s` for the whole generation and got its name in the last two frames.
`kimi-for-coding` and `k3-256k` behave the same; `xai` writes `path` first every time, but sends all
arguments in one delta, so its row has nothing to stream at all.

The order is not steerable, so do not try: a wording hint in the parameter description was deployed
and measured at 17% path-first over the next 51 writes against an 18–22% baseline, and the schema
wording was reverted. The full measurement (one tool vs a 15-tool request, `strict: true`, the
unstable key order) is in `docs/tool-rendering.md` §"Key order is the model's, not the schema's".
The row can report progress while a file is written; the name arrives when the model emits it.

## Why the settled row takes its path from the executed call

A row's arguments come from the stream (`message_update` → `updateArgs`) and Pi never refreshes them:
`tool_execution_start` discards `event.args` when the row already exists, and `message_end` only flips
`argsComplete`. So a row whose last streamed delta was short of the JSON tail keeps those partial args
for good — and the tail is exactly the `path` for every model here that emits `content` first. The row
then settles as `write ... 2.4k, 96 lines`: counts, no filename.

Execution always has the real arguments, so `execute()` stores them per tool call and every later
render of that row uses them — **including after it settles**: the row re-renders its call slot on any
invalidate (resize, Ctrl+O), and the streamed args it would otherwise fall back to carry neither the
`path` nor the final counts. The store is a per-session map bounded at 32 entries (oldest evicted),
which is where the cost of that stability sits. A row whose tool-call id never matched at all (a
gateway mutating ids mid-stream leaves a stale row behind) is resolved by content prefix against the
last 8 executed writes.

To capture the raw evidence for a rendering report, start Pi with `PI_WRITE_TRACE=1`; every call render
and execution appends a JSON line to `~/.pi/agent/logs/write-mode-trace.jsonl` (`src` = `final` /
`stream` / `match`, plus the keys, path, content length and phase flags).

## Deliberate omissions

No content preview and no diff, on purpose. The built-in renderer previews 10 lines, which stops
changing once the file passes 10 lines (the row looks frozen mid-generation), and an expanded diff is
the Ctrl+O flash bomb (`docs/burned.md`). This row is feedback about *progress*, not a viewer — read
the file when you want to see it.

## Why `path` arrives last (and stays that way)

Measured on this host: `path` is the first key in only **18%** of `write` calls on
`opencode-go/deepseek-v4.1-flash` and **22%** on `kimi-coding/kimi-for-coding` (`xai` is 100%, but it
sends all arguments in one delta, so its row stays path-less for a different reason). With the path
last, the header stays `write ...` for the entire generation — the placeholder Pi draws for an unknown
path, not a rendering bug.

A wording experiment in the `path` parameter description was deployed and reverted (17% path-first
over the next 51 writes, against an 18–22% baseline) — the schema is native again. The row is built to
read well without the name; do not re-add prompt text to steer key order.

## Implementation notes

- `renderCall` **and** `renderResult` are both supplied: an override that omits either gets the
  built-in one merged in for the missing piece (`docs/tool-rendering.md`).
- `renderShell: "default"` — Pi paints the pending/success/error box; the components return plain
  `Text`/`Container`, never hand-padded backgrounds.
- The pre-write file size is read once, while the args are complete **and** execution has not started
  (the file is still untouched then) and cached on the row's renderer state. A stat later would report
  the new size and the `1.1k → 2.4k` line would read `2.4k → 2.4k`; when the row's args only complete
  after the tool ran, the row drops the `was …` part instead of printing a wrong one.
- Per-row state lives in `context.state`, not on the component: Pi reuses one state object per tool
  row across call and result renders.
- Sizes are character counts, formatted `999` / `1.8k` — the same hint format as `pi-multi-edit`, in
  the row *and* in the model-facing result line.
- `execute` builds the native definition per call (`createWriteToolDefinition(cwd, { operations })`)
  so the byte-level write can report the pre-write size back into that call's scope; a module-level
  instance could not carry per-call state across parallel writes.
- Unit tests: `tests/unit/write-mode-persist.test.ts` (real files in a temp dir: BOM kept, verbatim
  bytes, old size), `tests/unit/write-mode-render.test.ts` (header + result line formatting).
