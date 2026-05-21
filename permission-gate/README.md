# Permission Gate

Unified safety gate for **bash**, **read**, **write**, and **edit** tool calls. Uses structural command analysis and a path-aware decision engine instead of regex heuristics.

## What it does

- **Bash commands**: Parsed into segments/pipelines/compounds. Risk is determined by a `CommandDB` (190 commands, 576 subcommands) rather than fragile regex.
- **Inline scripts**: `python -c`, `python - <<EOF`, and `node -e` are scanned for write/delete/network/execute patterns. Write/delete to paths outside the project requires confirmation even in YOLO mode.
- **Read/write/edit tools**: Path is classified as `inside_project`, `outside_project`, or `protected`. Protected roots (e.g. `C:\Windows`, `~/.ssh`, `~/.pi`) are blocked. Writes and edits outside the project/workspace require confirmation (single ask with "Allow this directory" option).
- **YOLO safe-read outside project**: In `yolo` mode, read-only commands (`ls`, `cat`, `rg`, `grep`, `find`, `head`, `tail`) that target paths outside the project are allowed automatically. Redirections to `/dev/null` or `nul` do not count as write operations.
- **Hard blocks**: Destructive commands (`rm -rf /`, `git reset --hard`, `format`, `diskpart`, `curl | sh`) are blocked without asking.
- **Session approvals**: Allowed commands can be remembered for the session.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-permission-gate
```

> **Important**: If you previously used `protected-paths`, disable or remove it. Permission Gate now includes all path-protection features.

## Modes

| Mode | Bash read | Bash write | Bash execute | Bash delete/install | Read outside project | Write outside project |
|------|-----------|------------|--------------|---------------------|----------------------|----------------------|
| `strict` | allow | ask | ask | ask | ask | block |
| `balanced` | allow | allow | ask | ask | ask (protected always block) | ask (double in strict) |
| `relaxed` | allow | allow | ask | ask | allow trusted / ask other | ask |
| `yolo` | allow | allow safe-read outside project | allow | ask | allow | ask |

Switch at runtime:

```text
/gate-mode strict
/gate-mode balanced
/gate-mode relaxed
/gate-mode yolo
```

Cycle modes without arguments:

```text
/gate-mode
```

This cycles `strict → balanced → relaxed → yolo` and shows the new mode.

Mode is persisted in `~/.pi/agent/settings.json` under `permissionGate.mode`.

## Workspace Roots

If you work with multiple projects under a common parent directory, add `workspaceRoots` to your settings so the gate treats every project inside as `inside_project`:

```json
{
  "permissionGate": {
    "mode": "yolo",
    "workspaceRoots": [
      "C:/10x001",
      "C:/projects"
    ]
  }
}
```

- Paths inside any workspace root are treated the same as the current `cwd` — no extra approvals for read/write/edit or bash write-like commands.
- Protected roots (`C:\Windows`, `~/.ssh`, etc.) are still blocked regardless of workspace roots.
- Changes take effect on the next session start (or run `/gate-mode` to force a reload).

## Architecture

```
tool_call
  ├── read  → path-guard (classifyPathAccess)
  ├── write → path-guard (ask if outside project/workspace)
  ├── edit  → path-guard (ask if outside project/workspace)
  └── bash  → tokenizer → analyzer (CommandDB + inline-scan) → engine
                ↓
         path-guard (traversal / external write check)
```

### CommandDB

Commands and their risks are declared in `commanddb.json` (loaded at runtime):

```json
{
  "git": {
    "defaultRisk": "write",
    "subcommands": {
      "status": { "risk": "read", "autoAllowModes": ["balanced", "relaxed", "yolo"] },
      "reset": {
        "risk": "write",
        "flags": { "--hard": { "effect": "escalate", "toRisk": "destructive" } }
      }
    }
  }
}
```

Adding a new command means adding a JSON entry — no regex required.

### Tokenizer

Correctly handles:
- Pipelines (`|`)
- Compounds (`&&`, `||`, `;`)
- Redirections (`>`, `>>`, `<`, `2>`)
- Single/double quotes and escapes

## Special behaviors

- **`curl ... | sh`** → hard-blocked as destructive (network + execute pipeline)
- **`$(...)` / `` `...` ``** in bash → treated as execute risk
- **`rm _temp.py`** → auto-allowed (safe temp delete heuristic)
- **`cd "C:/project" && echo > file.txt`** → allowed if the write target is inside the project (cd prefix is stripped from path check)
- **Git Bash paths (`/c/...`)** → correctly detected as outside-project / protected
- **`2>/dev/null` / `>nul`** → not treated as write risk; safe-read commands with null redirects are allowed in yolo
- **`find -exec` / `find -delete`** → escalated to execute / delete risk
- **Write/edit outside project/workspace denied** → model sees `User denied write/edit outside current project:` instead of generic `Blocked` for clearer correction
- **Visual approvals** → risk emoji (🟢 read, 🟡 write, 🔴 delete, ⛔ destructive) and structured prompt text for faster scanning

## Commands

| Command | Description |
|---------|-------------|
| `/gate-mode` | Cycle to the next mode (strict → balanced → relaxed → yolo). |
| `/gate-mode strict` | Switch to strict mode. |
| `/gate-mode balanced` | Switch to balanced mode. |
| `/gate-mode relaxed` | Switch to relaxed mode. |
| `/gate-mode yolo` | Switch to yolo mode. |

## Customizing

- Edit `commanddb.json` to add/modify command risks.
- Edit `types.ts`, `tokenizer.ts`, `analyzer.ts`, `inline-scan.ts` to change structural analysis logic.
- For safety, review CommandDB changes manually before relying on them.

## Compatibility

Tested with Pi v0.72.1 or newer.
