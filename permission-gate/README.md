# Permission Gate

Unified safety gate for **bash**, **read**, **write**, and **edit** tool calls. Uses structural command analysis and a path-aware decision engine instead of regex heuristics.

## What it does

- **Bash commands**: Parsed into segments/pipelines/compounds. Risk is determined by a `CommandDB` (190 commands, 576 subcommands) rather than fragile regex.
- **Read/write/edit tools**: Path is classified as `inside_project`, `outside_project`, or `protected`. Protected roots (e.g. `C:\Windows`, `~/.ssh`, `~/.pi`) are blocked. Writes outside the project require double confirmation.
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
| `balanced` | allow | allow | ask | ask | ask (protected always block) | double-ask |
| `relaxed` | allow | allow | ask | ask | allow trusted / ask other | double-ask |
| `yolo` | allow | allow | allow | ask | allow trusted / ask other | double-ask |

Switch at runtime:

```text
/gate-mode strict
/gate-mode balanced
/gate-mode relaxed
/gate-mode yolo
```

Check current mode:

```text
/gate-mode
```

Mode is persisted in `~/.pi/agent/settings.json` under `permissionGate.mode`.

## Architecture

```
tool_call
  ├── read  → path-guard (classifyPathAccess)
  ├── write → path-guard (double-ask if outside project)
  ├── edit  → path-guard (double-ask if outside project)
  └── bash  → tokenizer → analyzer (CommandDB) → engine
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

## Commands

| Command | Description |
|---------|-------------|
| `/gate-mode` | Show current mode. |
| `/gate-mode strict` | Strict — most things ask. |
| `/gate-mode balanced` | Balanced — safe read/write passes. |
| `/gate-mode relaxed` | Relaxed — optimized for agent work. |
| `/gate-mode yolo` | YOLO — only delete/install ask, destructive blocks. |

## Customizing

- Edit `commanddb.json` to add/modify command risks.
- Edit `types.ts`, `tokenizer.ts`, `analyzer.ts` to change structural analysis logic.
- For safety, review CommandDB changes manually before relying on them.

## Compatibility

Tested with Pi v0.72.1 or newer.
