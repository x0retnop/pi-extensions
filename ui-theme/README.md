# ui-theme

TUI chrome hub — custom footer, tok/s bar, ASCII splash (transient chat line), Working… toggle, **presets** (Pi theme + chrome).

## Install

Copy `ui-theme/` to `~/.pi/agent/extensions/` (keep shared `common/`). Restart Pi.

## Commands

| Command | Action |
|---------|--------|
| `/ui-theme` | Settings menu |
| `/ui-theme preset <id>` | Apply preset (`b2-dev`, `minimal`, …) |
| `/footer` · `/banner` | Shortcuts |

## Presets

JSON packs in `presets/`. **Authoring (agents):** `docs/extensions/ui-theme-presets.md`.

Shipped: `b2-dev`, `ember`, `phosphor`, `carrier`, `3v`, `minimal`, `stock-plus-rate`.

## Settings

`settings.json` → `uiTheme` (footer, frame, frameStyle/Fill/Title, frameBlu/Pur, barStyle, rate, maxTps, banner, bannerPrefer, working, boot, layout, preset).

## Not in this hub

a-rewind timer logic, role-sw, sub-agents status strings — domain status only. context-guard **boot content** stays there; **boot skin** is `uiTheme.boot`.
