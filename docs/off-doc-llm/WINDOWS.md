# Windows Setup

> Pi requires a bash shell on Windows.

---

## Shell discovery (in order)

1. Custom path from `~/.pi/agent/settings.json` → `shellPath`
2. Git Bash: `C:\Program Files\Git\bin\bash.exe`
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

### Custom shell path

```json
{ "shellPath": "C:\\cygwin64\\bin\\bash.exe" }
```

Most users: install [Git for Windows](https://git-scm.com/download/win) — sufficient.
