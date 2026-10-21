# simple-gate

Path-aware permission gate for `read`, `write`, `edit`, and `bash` tool calls.

## What it does

Intercepts `tool_call` events and decides whether to allow, ask, or block based on:
- command/path classification (`inside_project`, `outside_project`, `protected`)
- gate mode (`strict`, `relaxed`, `yolo`)
- known destructive patterns
- per-session allow lists

## Modes

| Mode | Read outside project | Write outside project | Destructive/protected |
|---|---|---|---|
| `strict` | Ask | Block | Block |
| `relaxed` | Allow | Ask | Block (destructive asks) |
| `yolo` | Allow | Ask | Ask |
| `off` | Allow all | Allow all | Allow all |

`off` persists like any other mode (`/gate-mode off` writes `simpleGate.mode`), so a restart stays disabled until you pick another mode.

## Important behaviors

- **Path classification** uses `cwd`, configured `workspaceRoots`, and hard-coded protected roots (`C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`, `C:\`, `~/.ssh`, `~/.config`, plus user `protectedRoots`).
- **Workspace roots** are configured in `~/.pi/agent/settings.json` → `simpleGate.workspaceRoots`.
- **Protected roots** are configured in `~/.pi/agent/settings.json` → `simpleGate.protectedRoots`.
- **Git Bash `/c/...` paths** are normalized to `C:/...` before classification.
- **Session allow lists** are cleared on `session_start` and `session_shutdown`.
- **Too-broad cwd** (`C:\`, home directory, Desktop, Documents, Downloads) is blocked entirely.
- **Redirections to `/dev/null` or `nul`** are ignored and do not count as write risk.

## State

- `~/.pi/agent/settings.json` → `simpleGate.mode`, `simpleGate.workspaceRoots`, `simpleGate.protectedRoots`.
