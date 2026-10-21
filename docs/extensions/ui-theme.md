# ui-theme

> Single TUI chrome hub (footer, rate, banner, working, presets, turn log, `/ui-theme`).
> Absorbed the archived `tool-timestamps` extension (inline tool timeline).

## Non-obvious

- **`setFooter` replaces** the built-in FooterComponent. Extension statuses still arrive via `footerData.getExtensionStatuses()` (fed by other extensions' `setStatus`). Stock custom footer layout:

  ```
  cwd • session                                          (provider) model • thinking
  ↑in ↓out R… CH… $…  bar  pct/window  ▸ rate
  timer | role | sub | web | …
  ```

  **`uiTheme.layout`** (preset JSON) rearranges that into named cells with fixed widths so tok/s, timer, tools, turn duration do not shove neighbors. Empty `rows` = stock 3-line. Authoring: `docs/extensions/ui-theme-presets.md` § layout. Rate is still published as `zz-rate` (so the tick keeps redrawing) but the custom footer paints it on the usage line and strips it from the status row. Built-in footer still shows `zz-rate` as a status block.
- **`statusSep`** joins status blocks after stripping the trailing ` |` that `setStatusBlock` appends. Default `" | "`. Inner pipes (timer `0:00 | 12 · 3`) stay.
- **Turn log** (`ui-theme/turnlog.ts`): one dim inline entry per finished LLM turn in the scrollback, merging the old per-call timestamp rows:

  ```
  08-09 20:09:09  turn 3 · 23.4s · ↑12.3k ↓1.2k R45k $0.012 · 4 tools
    ├─ read 45ms · grep 12ms · py 112ms
  ```

  Usage parts are independent and omitted at zero: `↑input ↓output R<cacheRead> W<cacheWrite> $cost`. `W` appears **only** when a provider reports cache-write tokens (Anthropic-native `cache_creation_input_tokens`, or an OpenAI gateway sending `cache_write_tokens` such as OpenRouter) — Kimi, xAI and OpenCode Go never do, so their entries end at `R…`. Same rule as the footer.

  Collapsed = first 4 tools on one line; expanded (tool-output-expand mode) = every tool with its target. Parallel tool calls collapse into the single turn entry — this is what de-noises the old `tool-timestamps` output. Live status block (`zz-turn`) shows `▶ 12.3s` during the turn and `✓ 43.0s` after it — duration only (tool counts live in the a-rewind tools cell).
- **Turn entries are persisted custom entries** (`pi.appendEntry("ui-turn", row)` on `turn_end` + `registerEntryRenderer`): rendered in session order, restored on `/resume`, never sent to the LLM. Entry data = `{ turnIndex, startMs, endMs, model?, httpStatus?, usage?, tools[] }`.
- **Model shown in a turn entry only when it differs** from the previous turn's model (the footer always shows the current model live).
- **Backfill limitation:** `/timestamps all` lists turns recorded from now on (custom entries of this session, incl. resumed ones). Pre-install turns of an old session have no entries — the old `tool-timestamps`-style history scan is not rebuilt.
- **Preset = Pi theme name + chrome pack.** Files in `presets/*.json`. Authoring: **`docs/extensions/ui-theme-presets.md`** (no code needed).
- **Frame colors** are hex in `uiTheme.frameBlu` / `framePur` → 24-bit ANSI at render time (`paint.ts`). Content rows still use Pi theme tokens.
- **Frame shape** is `frameStyle` (glyphs) + `frameFill` (split/solid/fade) + optional `frameTitle` on the top rule. `barStyle` changes CONTEXT and tok/s glyphs only. Defaults (`sharp`/`split`/`block`) match the original B2 box.
- **Boot ribbon skin** is `uiTheme.boot` (frame / rails / itemLead / itemMark / catMark). Consumed by context-guard on the next session start. Colors reuse `frameBlu` / `framePur`. Runtime `loadSurfaceChrome` never leaves the ribbon unframed: `boot.frame: none` inherits the footer `frameStyle` (else `sharp`). Rendered as transient chat text (`notify`), not a pinned widget — on `/resume` it sits at the end of the transcript and scrolls away. ui-theme takes the queued ribbon into the same notify as the banner so they do not replace each other.
- **Banner is a transient chat line, not a widget and not a session entry**: on `session_start` (skipped on extension `reload`) it renders into the transcript via `ctx.ui.notify(art, "info")` (TUI `showStatus`) — deferred past the initial render so it lands at the current view. It scrolls with the history, is **never written to the session file**, and is never sent to the LLM. Gone on the next transcript rebuild (session switch / new session). No dismiss logic needed — it is just chat text.
- **`bannerPrefer`** pins splash art; empty = random from `arts/`.
- Still imports `../common/status.js` (`setStatusBlock`) — runtime must keep shared `common/`.

## Settings (`uiTheme`)

Defaults: custom footer + B2 frame + rate + turn log + live turn status + banner, Working hidden.

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `footer` | bool | true | Custom `setFooter` chrome |
| `frame` | bool | true | Gradient frame around footer |
| `frameStyle` | string | sharp | Box glyphs: sharp / rounded / double / heavy / ascii / block |
| `frameFill` | string | split | Rule paint: split / solid / fade |
| `frameTitle` | string | "" | Label on the top rule |
| `frameBlu` / `framePur` | hex | #6496ff / #b464ff | Frame gradient halves |
| `barStyle` | string | block | CONTEXT + tok/s glyphs: block / density / hash / dot / rise |
| `statusSep` | string | ` | ` | Join between status blocks (line 3). Empty = tight |
| `rate` | bool | true | Tok/s bar (custom footer: on the usage line) |
| `maxTps` | number | 170 | Rate bar ceiling |
| `timeline` | bool | true | Turn-log inline entries |
| `turnLive` | bool | true | Live turn status block |
| `banner` | bool | true | ASCII splash as chat entry on session start |
| `bannerPrefer` | string | "" | Pin splash art |
| `working` | bool | false | Show Pi Working… row |
| `boot` | object | frame none | Skin for context-guard boot ribbon — see presets doc |
| `layout` | object | empty | Footer cells: `rows` + `cells` widths. Empty rows = stock 3-line |
| `preset` | string | "" | Last applied preset id |
