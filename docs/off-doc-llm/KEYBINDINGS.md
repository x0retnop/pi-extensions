# Keybindings

> Config: `~/.pi/agent/keybindings.json`. Apply: `/reload` (no restart needed).
> Source of truth: `dist/core/keybindings.js` (app.*) + `@earendil-works/pi-tui/dist/keybindings.js` (tui.*).

---

## Override format

`keybindings.json` is a JSON object mapping **binding ID → key(s)**. Only entries you want to change; everything absent keeps its default. No comments allowed in JSON (parse failure = all defaults silently).

```json
{
  "tui.editor.cursorLeft": "alt+j",
  "app.message.copy": ["ctrl+shift+c", "ctrl+x"],
  "app.session.new": []
}
```

- String = single key, array = alternatives, `[]` = disable the binding.
- Unknown IDs and non-string values (objects) are silently ignored.
- A `"_note"` string key is harmless (ignored) — usable as a pseudo-comment.
- Key format: `modifier+key`; modifiers `ctrl`, `shift`, `alt` (combinable); keys `a-z`, `0-9`, `escape`, `enter`, `tab`, `space`, `backspace`, `delete`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`, `f1`-`f12`, symbols.
- Conflicts: same key bound to two bindings → both still fire per context; Pi reports them via `getConflicts()`.

---

## Extension shortcuts (not in this file)

Extensions own keys through `pi.registerShortcut(KeyId, { description, handler })` — a **literal key** (`"f4"`, `"ctrl+alt+p"`), registered at extension startup, no config entry. Facts that bite:

- Not listed or rebindable by `/keys` (that editor only knows the built-in ids above). `/hotkeys` does list them, appended after the built-ins.
- The editor checks extension shortcuts **before** every built-in binding, so a shortcut wins over a built-in key that is not reserved.
- Reserved built-ins (`app.interrupt`, `app.clear`, `app.exit`, `app.suspend`, `app.thinking.cycle`, `app.model.cycle*`, `app.model.select`, `app.tools.expand`, `app.thinking.toggle`, `app.editor.external`, `app.message.copy`, `app.message.followUp`, `tui.input.submit`, `tui.select.confirm`, `tui.select.cancel`, `tui.input.copy`, `tui.editor.deleteToLineEnd`) can't be overridden: the shortcut is skipped with a startup warning. Non-reserved collisions load with a warning.
- Disabling a built-in here (`[]`) frees its key for an extension shortcut. Moving an extension shortcut is a code change plus `/reload` (extensions reload) or a Pi restart — editing `keybindings.json` has no effect on it.

---

## Editor

| ID | Default | Description |
|----|---------|-------------|
| `tui.editor.cursorUp` | `up` | Move up |
| `tui.editor.cursorDown` | `down` | Move down |
| `tui.editor.cursorLeft` | `left`, `ctrl+b` | Move left |
| `tui.editor.cursorRight` | `right`, `ctrl+f` | Move right |
| `tui.editor.cursorWordLeft` | `alt+left`, `ctrl+left`, `alt+b` | Word left |
| `tui.editor.cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | Word right |
| `tui.editor.cursorLineStart` | `home`, `ctrl+home`, `ctrl+a` | Line start |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+end`, `ctrl+e` | Line end |
| `tui.editor.jumpForward` | `ctrl+]` | Jump to char |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | Jump backward |
| `tui.editor.pageUp` | `pageUp`, `ctrl+pageUp` | Page up |
| `tui.editor.pageDown` | `pageDown`, `ctrl+pageDown` | Page down |
| `tui.editor.historyPrevious` | **none** | Previous history entry (unbound by default) |
| `tui.editor.historyNext` | **none** | Next history entry (unbound by default) |
| `tui.editor.deleteCharBackward` | `backspace` | Delete backward |
| `tui.editor.deleteCharForward` | `delete`, `ctrl+d` | Delete forward |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace` | Word backward |
| `tui.editor.deleteWordForward` | `alt+d`, `alt+delete` | Word forward |
| `tui.editor.deleteToLineStart` | `ctrl+u` | To line start |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | To line end |
| `tui.editor.yank` | `ctrl+y` | Yank (paste killed text) |
| `tui.editor.yankPop` | `alt+y` | Cycle yank history |
| `tui.editor.undo` | `ctrl+-` | Undo |

Clipboard (cut/copy/paste) and select-all are handled by the terminal, not configurable here.

## Input

| ID | Default | Description |
|----|---------|-------------|
| `tui.input.newLine` | `shift+enter`, `ctrl+j` | New line |
| `tui.input.submit` | `enter` | Submit |
| `tui.input.tab` | `tab` | Tab/autocomplete |
| `tui.input.copy` | `ctrl+c` | Copy selection |

## Select (pickers / menus)

| ID | Default | Description |
|----|---------|-------------|
| `tui.select.up` | `up` | Move up |
| `tui.select.down` | `down` | Move down |
| `tui.select.pageUp` | `pageUp` | Page up |
| `tui.select.pageDown` | `pageDown` | Page down |
| `tui.select.confirm` | `enter` | Confirm |
| `tui.select.cancel` | `escape`, `ctrl+c` | Cancel |

## AltScreen (scroll viewport / fullscreen)

| ID | Default | Description |
|----|---------|-------------|
| `tui.altScreen.pageUp` | `pageUp` | Scroll up one page |
| `tui.altScreen.pageDown` | `pageDown` | Scroll down one page |
| `tui.altScreen.halfPageUp` | **none** | Scroll up half page |
| `tui.altScreen.halfPageDown` | **none** | Scroll down half page |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up` | Previous semantic prompt |
| `tui.altScreen.nextPrompt` | `ctrl+shift+down` | Next semantic prompt |
| `tui.altScreen.top` | `home` | Viewport to top |
| `tui.altScreen.bottom` | `end` | Viewport to bottom |

## App (agent)

| ID | Default | Description |
|----|---------|-------------|
| `app.interrupt` | `escape` | Cancel/abort current run |
| `app.clear` | `ctrl+c` | Clear editor |
| `app.exit` | `ctrl+d` | Exit when editor empty |
| `app.suspend` | **none** (win32), `ctrl+z` (unix) | Suspend to background |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.thinking.toggle` | `ctrl+t` | Toggle thinking blocks |
| `app.model.cycleForward` | `ctrl+p` | Next model |
| `app.model.cycleBackward` | `shift+ctrl+p` | Previous model |
| `app.model.select` | `ctrl+l` | Open model selector |
| `app.tools.expand` | `ctrl+o` | Toggle tool output |
| `app.session.toggleNamedFilter` | `ctrl+n` | Toggle named session filter |
| `app.editor.external` | `ctrl+g` | Open external editor |
| `app.message.copy` | `ctrl+x` | Copy message to clipboard |
| `app.message.followUp` | `alt+enter` | Queue follow-up message |
| `app.message.dequeue` | `alt+up` | Restore queued messages |
| `app.clipboard.pasteImage` | `alt+v` (win32), `ctrl+v` (unix) | Paste image from clipboard |
| `app.session.new` | **none** | Start new session |
| `app.session.tree` | **none** | Open session tree |
| `app.session.fork` | **none** | Fork current session |
| `app.session.resume` | **none** | Resume a session |
| `app.session.rename` | `ctrl+r` | Rename session |
| `app.session.delete` | `ctrl+d` | Delete session |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | Delete session when query empty |
| `app.session.togglePath` | `ctrl+p` | Toggle session path display |
| `app.session.toggleSort` | `ctrl+s` | Toggle session sort mode |
| `app.tree.foldOrUp` | `ctrl+left`, `alt+left` | Fold branch / move up |
| `app.tree.unfoldOrDown` | `ctrl+right`, `alt+right` | Unfold branch / move down |
| `app.tree.editLabel` | `shift+l` | Edit tree label |
| `app.tree.toggleLabelTimestamp` | `shift+t` | Toggle label timestamps |

## Model manager (picker screen)

| ID | Default | Description |
|----|---------|-------------|
| `app.models.save` | `ctrl+s` | Save selection |
| `app.models.enableAll` | `ctrl+a` | Enable all |
| `app.models.clearAll` | `ctrl+x` | Clear all |
| `app.models.toggleProvider` | `ctrl+p` | Toggle provider |
| `app.models.reorderUp` | `alt+up` | Move up |
| `app.models.reorderDown` | `alt+down` | Move down |

## Tree filters

| ID | Default | Description |
|----|---------|-------------|
| `app.tree.filter.default` | `ctrl+d` | Default view |
| `app.tree.filter.noTools` | `ctrl+t` | Hide tool results |
| `app.tree.filter.userOnly` | `ctrl+u` | User messages only |
| `app.tree.filter.labeledOnly` | `ctrl+l` | Labeled only |
| `app.tree.filter.all` | `ctrl+a` | Show all |
| `app.tree.filter.cycleForward` | `ctrl+o` | Cycle forward |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o` | Cycle backward |

## Notes

- Defaults ship with a built-in conflict: `ctrl+d` = `app.exit` (empty editor) and `app.session.delete` (tree). Context-scoped, but unbind one if it ever bites.
- Contexts matter: e.g. `ctrl+p` is model-cycle, history (unbound), session-path toggle — whichever screen is active wins.
