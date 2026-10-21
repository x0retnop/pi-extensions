# pi-agent-run

Pi extension that bypasses bash for Windows-native code execution.

## Tools

- `pwsh` — Execute PowerShell 7 code directly. No bash quoting/escaping. Keep scripts short (~20-30 lines); for longer scripts, create a `.ps1` file and run it.
- `py` — Execute Python code directly. No bash heredoc escaping. Keep scripts short (~20-30 lines); for longer scripts, create a `.py` file and run it.

Both tools render their calls with syntax highlighting and collapse long code blocks to a configurable number of preview lines.

## Why

The built-in `bash` tool on Windows routes through Git Bash (MSYS2), which
mangles PowerShell/Python quoting, paths, and environment variables. This
extension gives the agent native executors so it can use Windows paths and
PowerShell syntax directly.

## Usage

```json
{
  "name": "pwsh",
  "arguments": {
    "code": "Get-Process | Where-Object { $_.Name -eq 'chrome' } | Select-Object Name, Id",
    "timeout": 15
  }
}
```

```json
{
  "name": "py",
  "arguments": {
    "code": "import os\nprint(os.getcwd())",
    "timeout": 10
  }
}
```

## Configuration

Use the `/agent-run` command in Pi to open a TUI and configure each tool separately:

- **Preview lines** — how many lines of code are shown in collapsed tool calls (1–50, default 8).
- **Syntax highlighting** — on/off.
- **Highlight mode** — `powershell`, `python`, `auto`, or `none`.

Settings are stored in `settings.json` next to the extension entry point.

### Default settings

```json
{
  "pwsh": {
    "previewLines": 8,
    "highlight": true,
    "highlightMode": "powershell"
  },
  "py": {
    "previewLines": 8,
    "highlight": true,
    "highlightMode": "python"
  }
}
```

PowerShell highlighting is handled by a built-in lightweight tokenizer so cmdlet names, parameters, strings, variables and operators are colored using the active Pi theme. Python highlighting uses Pi's built-in highlighter.

## Notes

- `timeout` defaults to **120 seconds**. Set it to `0` to disable the timeout.
- `failOnError` defaults to `true`. Set it to `false` to capture the output and exit code of commands that return non-zero.
- `cwd` sets the working directory for the command.
- Python scripts run via `python -`, so `__file__` is undefined and relative paths resolve from Pi's working directory.
- Long-running tools show an elapsed timer in the header after **5s** (updates once per second).
- Large outputs are truncated inline; the full log is written under the OS temp dir and cleaned on the next session start.
- `pwsh` bootstraps `~/.pi/agent/profile.ps1` when present (via `getAgentDir()`).

## Sync to runtime

Copy this folder to `C:\Users\user\.pi\agent\extensions\pi-agent-run\` and
restart Pi.
