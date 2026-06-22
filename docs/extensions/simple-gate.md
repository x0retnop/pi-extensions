# simple-gate

Path-aware permission gate for `read`, `write`, `edit`, and `bash` tool calls.

## What it does

Intercepts `tool_call` events and decides whether to allow, ask, or block based on:
- command/path classification (`inside_project`, `outside_project`, `protected`)
- gate mode (`strict`, `relaxed`, `yolo`)
- known destructive patterns
- per-session allow lists

## Commands

- `/gate-mode` — cycle mode.
- `/gate-mode strict|relaxed|yolo|off` — set mode directly.

## Modes

| Mode | Read outside project | Write outside project | Destructive/protected |
|---|---|---|---|
| `strict` | Ask | Block | Block |
| `relaxed` | Allow | Ask | Block (destructive asks) |
| `yolo` | Allow | Ask | Ask |
| `off` | Allow all | Allow all | Allow all |

`off` mode does not persist. Restarting Pi falls back to the saved mode.

## Important behaviors

- **Path classification** uses `cwd`, configured `workspaceRoots`, and hard-coded protected roots (`C:\Windows`, `C:\Program Files`, `C:\`, `~/.ssh`, `~/.config`, plus user `protectedRoots`).
- **Workspace roots** are configured in `~/.pi/agent/settings.json` → `simpleGate.workspaceRoots`.
- **Protected roots** are configured in `~/.pi/agent/settings.json` → `simpleGate.protectedRoots`.
- **Git Bash `/c/...` paths** are normalized to `C:/...` before classification.
- **Session allow lists** are cleared on `session_start` and `session_shutdown`.
- **Too-broad cwd** (`C:\`, home directory, Desktop, Documents, Downloads) is blocked entirely.
- **Redirections to `/dev/null` or `nul`** are ignored and do not count as write risk.

## State

- `~/.pi/agent/settings.json` → `simpleGate.mode`, `simpleGate.workspaceRoots`, `simpleGate.protectedRoots`.

## Source

- `simple-gate/index.ts` — decision engine and UI prompts.
- `simple-gate/path-guard.ts` — path normalization and classification.
