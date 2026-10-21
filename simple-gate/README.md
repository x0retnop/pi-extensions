# Simple Gate

Minimal path-based permission gate for **bash**, **read**, **write**, and **edit**. No CommandDB, no tokenizer, no regex arms race — decisions are based only on where a command operates.

## What it does

- **Protected paths** (`C:\Windows`, `~/.ssh`, `~/.pi`, etc.) — block in `strict`/`relaxed`, **ask** in `yolo`. You can add your own in config.
- **Read tool** — allow inside project/workspace. Outside: allow in `relaxed`/`yolo`, ask in `strict`.
- **Write / Edit tool** — allow inside project/workspace. Outside: block in `strict`, ask in `relaxed`/`yolo`. Protected: block in `strict`/`relaxed`, ask in `yolo`.
- **Bash** — extracts paths from the shell command. If any path is protected → block in `strict`/`relaxed`, **ask** in `yolo`. If write-like command (cp, mv, rm, mkdir, redirect `>`) targets outside project → block in `strict`, ask otherwise. In `strict`, any access outside project asks.
- **Destructive deny-list** (`curl ... | sh`, `rm -rf /`, `format`, `diskpart`, `dd to /dev/sd*`) — block in `strict`/`relaxed`, **ask** in `yolo`.
- **Heredocs** (`python <<EOF`, `cat <<EOF`) — bodies are treated as data, not shell syntax. String literals inside them (e.g. `'\\'`) do not trigger false blocks.
- **Git Bash paths** — `/c/...` notation is resolved correctly to `C:\...` on Windows.

## Install

```bash
pi install ./simple-gate
```

> Disable or remove `permission-gate` first to avoid command conflicts.

## Config

`~/.pi/agent/settings.json`:

```json
{
  "simpleGate": {
    "mode": "relaxed",
    "protectedRoots": [
      "C:\\SecretFolder",
      "~\\.my-secrets"
    ],
    "workspaceRoots": [
      "C:/10x001",
      "C:/projects"
    ]
  }
}
```

- `mode` — `strict | relaxed | yolo`
- `protectedRoots` — additional roots beyond the built-in defaults
- `workspaceRoots` — treat subdirectories as inside-project

## Modes

| Mode | Read outside | Write outside | Bash write outside | Bash read outside | Protected | Destructive patterns |
|------|--------------|---------------|--------------------|-------------------|-----------|---------------------|
| `strict` | ask | block | block | ask | **block** | **block** |
| `relaxed` | allow | ask | ask | allow | **block** | **block** |
| `yolo` | allow | ask | ask | allow | **ask** | **ask** |

## Commands

```text
/gate-mode strict
/gate-mode relaxed
/gate-mode yolo
/gate-mode        # cycles strict → relaxed → yolo
```

Mode is persisted in `~/.pi/agent/settings.json` under `simpleGate.mode`.

## Why this exists

`permission-gate` grew a 190-command database, inline scanners, and tokenizers to predict intent. In practice agents generate endless variations of compound commands and pipelines, causing false blocks and constant patches. `simple-gate` drops intent prediction and only guards **where** operations happen.
