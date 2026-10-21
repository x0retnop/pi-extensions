# keybinds

TUI editor for `~/.pi/agent/keybindings.json`.

## Install

Copy `keybinds/` to `~/.pi/agent/extensions/` and restart Pi.

## Commands

| Command | Action |
|---------|--------|
| `/keys` | Open the editor |
| `/keybindings` | Alias |

## In the editor

List shows Pi descriptions, keys in a column. `r` rebind (press a key) · `a` add · `e` type chord · `x` disable · `u` restore default · `o` cycle view (all / changed / unbound) · `/` filter · `q` close. Enter does not rebind. Status does not replace the hint bar.

First save of an annotated full dump writes a backup to `keybindings.json.bak`, then keeps only real overrides.
