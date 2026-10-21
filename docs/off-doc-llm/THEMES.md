# Themes

> JSON files defining TUI colors.

---

## Locations

| Path | Scope |
|------|-------|
| Built-in: `dark`, `light` | Built-in |
| `~/.pi/agent/themes/*.json` | Global |
| `.pi/themes/*.json` | Project (trusted) |
| Package `themes/` dir or `pi.themes` in package.json | Packages |
| Settings `themes` array | Settings |
| `--theme <path>` | CLI |

Disable: `--no-themes`.

---

## Select

```json
{ "theme": "my-theme" }
```

Via `/settings` or `settings.json`. Pi auto-detects terminal background on first run.

---

## Format

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242,
    "success": "#00ff00",
    "warning": "#ffaa00",
    "error": "#ff0000",
    "info": "#0088ff",
    "background": "#1a1a2e",
    "surface": "#16213e",
    "border": "#0f3460",
    "text": "#e0e0e0",
    "textMuted": "#888888",
    "textAccent": "#ffffff",
    "editorBg": "#0d1117",
    "editorText": "#c9d1d9",
    "editorCursor": "#58a6ff",
    "editorSelection": "#3b5998",
    "selectionBg": "#264f78",
    "selectionText": "#ffffff",
    "lineNumbers": "#484f58",
    "scrollbar": "#30363d",
    "scrollbarHover": "#484f58",
    "scrollbarActive": "#6e7681",
    "tooltipBg": "#1c2128",
    "tooltipText": "#e6edf3",
    "tooltipBorder": "#444c56"
  }
}
```

### Color values

- Hex: `"#rrggbb"` or `"#rgb"`
- ANSI: number `0-255`
- Named: terminal color names (limited support)
