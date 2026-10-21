# ui-theme presets — authoring guide (agents)

> Drop a JSON file in `ui-theme/presets/`. No code changes. Restart Pi (or reload extensions) to pick up new files.

## What a preset is

```
preset = optional Pi theme name  +  chrome pack (footer / frame / rate / banner / …)
```

| Layer | Controlled by | Mechanism |
|-------|---------------|-----------|
| **Pi colors** (accent, tool bg, md…) | `piTheme` | `ctx.ui.setTheme(name)` — must already be a known theme |
| **Chrome layout/paint** | `chrome{}` | written into `settings.json` → `uiTheme` |

Not in scope: tool-card renderers, a-rewind/role-sw status ANSI (separate extensions). Boot **ribbon skin** is in scope (`chrome.boot`).

## File location

```
ui-theme/presets/<id>.json
```

- One preset per file.
- Filename stem becomes `id` if `"id"` omitted.
- Skip files starting with `_` or `.`.
- Ship with the extension folder when deploying to `~/.pi/agent/extensions/ui-theme/`.

## Schema

```json
{
  "id": "my-pack",
  "name": "My Pack",
  "description": "One-line blurb shown in /ui-theme menu",
  "piTheme": "dark-clean-code",
  "chrome": {
    "footer": true,
    "frame": true,
    "frameStyle": "sharp",
    "frameFill": "split",
    "frameTitle": "",
    "frameBlu": "#6496ff",
    "framePur": "#b464ff",
    "barStyle": "block",
    "statusSep": " | ",
    "rate": true,
    "maxTps": 170,
    "timeline": true,
    "turnLive": true,
    "banner": true,
    "bannerPrefer": "",
    "working": false,
    "boot": {
      "frame": "none",
      "title": "prefix",
      "rails": false,
      "rail": "▓▓",
      "sep": " · ",
      "itemLead": "",
      "itemMark": "",
      "catMark": "",
      "frameTitle": ""
    }
  }
}
```

### Fields

| Key | Type | Default if omitted | Notes |
|-----|------|--------------------|-------|
| `id` | string | filename stem | Stable id stored in `uiTheme.preset` after apply |
| `name` | string | `id` | Menu label |
| `description` | string | `""` | Menu subtitle (truncated) |
| `piTheme` | string | `""` | **Empty = do not change** active Pi theme. Name must exist in `ctx.ui.getAllThemes()` (built-in `dark`/`light`, `~/.pi/agent/themes/*.json`, package themes, settings `themes` paths) |
| `chrome.footer` | bool | leave current | `true` = custom `setFooter`; `false` = built-in footer |
| `chrome.frame` | bool | leave current | Gradient box around custom footer (only if footer custom) |
| `chrome.frameStyle` | string | leave current | Box glyphs: `sharp` `┌` / `rounded` `╭` / `double` `╔` / `heavy` `┏` / `ascii` `+` / `block` `▛` |
| `chrome.frameFill` | string | leave current | Rule paint: `split` (halves) / `solid` / `fade` (lerp between the two hexes) |
| `chrome.frameTitle` | string | leave current | Label inset on the top rule. `""` = none |
| `chrome.frameBlu` | hex | leave current | Left half of frame gradient `#RRGGBB` or `#RGB` |
| `chrome.framePur` | hex | leave current | Right half |
| `chrome.barStyle` | string | leave current | CONTEXT + tok/s glyphs: `block` `█░` / `density` `█▓▒░` / `hash` `#-` / `dot` `●○` / `rise` `▁▂▃▅▆▇█▓` (empty = space, terminal bg) |
| `chrome.statusSep` | string | leave current | Join between footer status blocks. Default `" | "`. Empty = tight. Max 8 chars |
| `chrome.rate` | bool | leave current | Tok/s bar. Custom footer paints it on the usage line; built-in footer keeps it as a status block |
| `chrome.maxTps` | number > 0 | leave current | Rate bar ceiling (default stock 170) |
| `chrome.timeline` | bool | leave current | Turn-log entries in scrollback (one dim row-set per finished turn, tools merged; absorbed `tool-timestamps`) |
| `chrome.turnLive` | bool | leave current | Live turn status via `setStatus("zz-turn")`: `▶ 12.3s` during the turn, `✓ 43.0s` after |
| `chrome.banner` | bool | leave current | ASCII splash as a **transient chat line** on session start (startup/new/resume/fork; skipped on extension reload) — rendered via `notify`, never written to the session file |
| `chrome.bannerPrefer` | string | leave current | Art name/substring; `""` = random from `ui-theme/arts/` |
| `chrome.working` | bool | leave current | `true` = show Pi Working… row; `false` = hide |
| `chrome.boot` | object | leave current | Skin for the context-guard boot ribbon (next session start). Partial keys OK. Colors = `frameBlu` / `framePur`. |
| `chrome.layout` | object | leave current | Footer cell map. `"layout": {}` restores stock 3-line. See **Footer layout** below. |

`chrome.boot` keys:

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `frame` | string | none | `none` / `sharp` / `rounded` / `double` / `heavy` / `ascii` / `block`. Runtime `none` inherits footer `frameStyle` (boot is always boxed) |
| `title` | string | prefix | `prefix` = `prompt` / `tools` on the line; `in-border` = optional `frameTitle` on the top rule; `none` = items only |
| `rails` | bool | false | `▓▓ … ▓▓` strips above/below |
| `rail` | string | ▓▓ | Rail glyph (max 8) |
| `sep` | string | ` · ` | Join between items |
| `itemLead` | string | "" | Before each item, e.g. `"▐ "` |
| `itemMark` | string | "" | After each item, e.g. `" ✓"` |
| `catMark` | string | "" | After the category label, e.g. `" ►"` |
| `frameTitle` | string | "" | Label on the top rule when `title` is `in-border` |

Example extras (any frame + garnish):

```
prompt ► ▐ date ✓ · ▐ workdir ✓
```

→ `"frame": "double", "catMark": " ►", "itemLead": "▐ ", "itemMark": " ✓"`

**Partial chrome is OK.** Only listed keys are patched; others keep the user's current `uiTheme` values. Full-chrome packs (`b2-dev`, `ember`, `phosphor`, `carrier`) send `"layout": {}` so they wipe a HUD layout when applied.

## Footer layout

`chrome.layout` is how rearrangements and fixed cell sizes work. Empty `rows` = stock 3-line chrome (cwd/model, usage+rate, statuses). Non-empty `rows` replace that.

```json
"layout": {
  "embed": true,
  "pad": 3,
  "sep": " ░ ",
  "cells": {
    "total": { "w": 5, "align": "right" },
    "last": { "w": 5, "align": "right" },
    "tools": { "w": 6, "align": "right" },
    "turn": 8,
    "rate-bar": 11,
    "rate-num": 4
  },
  "rows": [
    { "left": ["total", " · ", "last", "tools", "turn", "rate-bar", "rate-num", "   ", "context"], "right": ["model"] },
    "usage",
    { "left": ["cwd"], "right": ["role", "sub-agents", "web-access"] }
  ]
}
```

| Key | Meaning |
|-----|---------|
| `embed` | First/last content lines sit in the frame corners (`╭ content ╮` / `╰ content ╯`) instead of extra ─ rules. 3 content rows → 3 painted rows. |
| `pad` | Spaces inside both corners/walls (0–8). |
| `sep` | Join between cells. Empty = `statusSep`. Max 8 chars. |
| `cells` | Per-cell visible width. Number = left-aligned width. `{ "w": N, "align": "right" }` right-aligns inside the slot (timer/tools). **Width 0 / omitted = shrink-wrap** (neighbors jump). Empty text with a width still occupies the slot. |
| `rows` | 1–6 lines. Each item is a string (`"left cells \| right cells"`), an array, or `{ "left": [...], "right": [...] }`. `\|` splits left vs right-pinned. |

**Tokens:** `[A-Za-z_][A-Za-z0-9_-]*` = cell id. Anything else (`·`, `░`, ` | `) is a literal separator for the gap it sits in.

Builtin cells:

| id | Content |
|----|---------|
| `clock` | wall-clock `HH:MM` (not used by `3v`) |
| `cwd` / `session` / `cwd-session` | path, session name, or `cwd • name` |
| `model` | `(provider) name • thinking` |
| `usage` | `↑ ↓ R W CH $` session totals |
| `context` | CONTEXT bar + `pct/window` |
| `rate` | full tok/s `▸ bar num` |
| `rate-bar` / `rate-num` | `▸ ▁▂…` and padded `2···` as separate slots |
| `timer` | a-rewind time half (`11:01 · 0:43` = total · last turn) |
| `total` / `last` | those two halves as separate slots (not wall-clock) |
| `tools` | a-rewind call-count half (`30 · 0`) |
| `turn` | `▶ 12.3s` live / `✓ 43.0s` done |
| `status` | leftover extension statuses not named in the rows |
| `_` / `zz-turn` / `zz-rate` / `role` / `sub-agents` / `web-access` / `gate` / … | raw `setStatus` key |

Widths on stock layout (no `rows`) still pad line-3 statuses by key — so `"cells": { "role": 24 }` alone stops the role label from shoving `web:on`.

Edit `ui-theme/presets/3v.json` to rearrange; copy the folder to runtime and restart.

### Flat form (optional)

Tiny presets may put chrome keys on the root instead of under `chrome` — both work. Nested `chrome` wins for clarity; prefer nested.

## Apply (user / agent)

```
/ui-theme                     → menu → "Preset: …"
/ui-theme preset b2-dev       → apply by id or name
/ui-theme preset              → list ids
/ui-theme b2-dev              → shorthand
```

Apply side-effects:

1. Merge `chrome` into live settings → write `~/.pi/agent/settings.json` key `uiTheme` (sets `preset` to id).
2. If `piTheme` non-empty → `setTheme` (persisted by Pi settingsManager).
3. Reinstall footer / rate / working visibility.
4. If `banner` on → render splash as a chat line (honors `bannerPrefer`).

Manual toggles after a preset clear `uiTheme.preset` (no longer “clean” pack).

## Shipped examples

| id | Intent |
|----|--------|
| `b2-dev` | Full chrome + sharp split B2 frame + `dark-clean-code` |
| `ember` | Full chrome + sharp amber→rust frame + `ember-night` |
| `phosphor` | Full chrome + sharp mint→teal frame + `phosphor-night` |
| `carrier` | Double NFO frame, magenta→cyan fade, ICE title, density bars + `carrier-night` |
| `3v` | Rounded rails HUD: total·last / tools / turn / rate / context, fixed widths. Pi theme unchanged |
| `minimal` | Built-in footer, no rate/banner; Pi theme unchanged |
| `stock-plus-rate` | Built-in footer + tok/s only |

## Adding a Pi color theme (if preset needs new colors)

Presets only **select** a Pi theme by name — they do not embed color tokens.

1. Author a Pi theme JSON (`name`, `vars`, `colors`) — see `docs/off-doc-llm/THEMES.md` and repo `themes/dark-clean-code.json`.
2. Install it where Pi discovers themes:
   - `~/.pi/agent/themes/<name>.json`, or
   - settings `"themes": ["C:/path/to/file.json"]`, or
   - package `themes/` / `pi.themes`.
3. Set preset `"piTheme": "<name>"` to that exact `name` field.

If `setTheme` fails, chrome still applies; user sees a warning notify.

## Banner arts

- Path: `ui-theme/arts/*.{art,txt,ansi}`
- Optional headers: `# name: …`, `# color: auto|plain|<themeFgKey>`
- Markup: `{{accent}}text{{/}}` (theme fg keys)
- `bannerPrefer` matches art `name` or filename (exact, then substring)
- The banner renders as a **transient chat line** (`ctx.ui.notify(..., "info")` → TUI `showStatus`): scrolls with the history, is **not persisted** (nothing written to the session file), not sent to the LLM, gone on the next transcript rebuild.

## settings.json shape after apply

```json
{
  "theme": "dark-clean-code",
  "uiTheme": {
    "footer": true,
    "frame": true,
    "frameStyle": "sharp",
    "frameFill": "split",
    "frameTitle": "",
    "frameBlu": "#6496ff",
    "framePur": "#b464ff",
    "barStyle": "block",
    "statusSep": " | ",
    "rate": true,
    "maxTps": 170,
    "timeline": true,
    "turnLive": true,
    "banner": true,
    "bannerPrefer": "",
    "working": false,
    "boot": { "frame": "none", "title": "prefix", "rails": false, "rail": "▓▓", "sep": " · ", "itemLead": "", "itemMark": "", "catMark": "", "frameTitle": "" },
    "preset": "b2-dev"
  }
}
```

## Checklist — new preset without code

1. [ ] Decide Pi theme name (existing) or add theme JSON first.
2. [ ] Write `ui-theme/presets/<id>.json` with `piTheme` + partial/full `chrome`.
3. [ ] Copy updated `ui-theme/` (include `presets/`) to runtime extensions.
4. [ ] Restart Pi → `/ui-theme preset <id>` → verify footer/frame/banner + theme.
5. [ ] If frame colors wrong: check hex `#RRGGBB`. If theme missing: `/ui-theme` → Pi theme list.

## Non-goals (do not put in preset JSON)

- Tool `renderCall` / `renderResult` styling
- role-sw / a-rewind / sub-agents status string colors (boot ribbon skin is `chrome.boot`, not this list)
- Keybindings, models, providers
- Editing Pi built-in components beyond footer/working/banner APIs
