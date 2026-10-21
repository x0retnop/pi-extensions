# keybinds

> TUI for `~/.pi/agent/keybindings.json` (`/keys`). Not chrome — do not fold into `ui-theme`.

## Non-obvious

- **Live apply:** writes the file, then `KeybindingsManager.setUserBindings()`. No `/reload`, no restart.
- **Only Pi's built-in actions.** The list is the fixed registry in `dist/core/keybindings.js` (`app.*`) + pi-tui (`tui.*`). Extensions cannot add an id here — `pi.registerShortcut()` is the only way for an extension to own a key, it is hard-coded at startup, and `getShortcuts()` only reads this config to detect conflicts. So `/keys` can neither show nor rebind extension shortcuts (e.g. a-rewind `F4`, model-manager `F2`/`F3`); `/hotkeys` lists them.
- **Sparse file:** only keys that differ from Pi defaults. `[]` = disabled. Missing = default. `_note` is a dummy key Pi ignores.
- **Annotated dump:** the old all-83-bindings + `_id` comments file is backed up once to `keybindings.json.bak` on first save, then compacted. List labels come from Pi's `getDefinition().description`, not from those comments.
- **Hint bar never yields to status.** Save/error text sits on the selected-item detail line. `?` only expands the hint bar.
- **One `ctx.ui.custom` only.** Do not nest `ui.select` / `ui.confirm` — that leaves the outer promise pending (same class of bug as model-manager / session-memory).
- **Capture Esc always cancels**, never binds Escape. Bind it via `e` and type `escape`.
- **Conflicts** (`!`) are same-key clashes from `getConflicts()`. Context-scoped pairs (editor vs tree) can be harmless.
- **Unknown ids are ignored silently** — a typo in `keybindings.json` behaves like "not set", no error. `[]` disables, `""`/missing keeps the default.

## Editor keys

| Key | Action |
|-----|--------|
| `r` | Replace keys: next keypress becomes the only binding |
| `a` | Add an alternative key |
| `e` | Type chord(s), comma-separated (`ctrl+shift+c` or `left, ctrl+b`) |
| `x` | Disable (`[]`) |
| `u` | Restore Pi default (drops the override) |
| `o` | Cycle view: changed → unbound → all |
| `/` | Filter (id / description / key) |
| `c` | Next conflict |
| `g` / `G` | Top / bottom |
| `?` | Extra help line |
| `q` / Esc | Close |

Default view is **all**. `o` cycles all → changed → unbound. `*` = differs from default; `off` = disabled. List is description + keys column, grouped (session/tree not split). Full id is on the detail line.
