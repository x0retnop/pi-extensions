# pi-agent-run

Bypass bash for Windows-native code execution.

## Why it exists

Git Bash (MSYS2) used by Pi's built-in `bash` tool reinterprets quotes, `$`,
backticks, and paths before they reach PowerShell or Python. This causes
quoting errors, PATH mangling, and namespace confusion (`C:\c\...`).

`pi-agent-run` registers native executors that receive the code as a plain JSON
string and run it directly, skipping bash entirely.

## Non-obvious

- **Which executor.** `pwsh` for Windows-native work (registry, WMI/CIM, processes, services, network, native exes, cmd legacy); `py` for parsing, analysis and automation scripts.
- **PowerShell exits 1 on "no results".** When checking for absence (`Get-Process`, `Remove-Item`, `Get-ChildItem` with `-ErrorAction SilentlyContinue`), PowerShell returns exit code 1 even though the command did its job. Pass `expectedExitCodes: [0, 1]` to treat that as success while still capturing output.

## Rendering

- `pwsh` / `py`: custom `renderCall` **and** `renderResult`. The result renderer matters: with none, Pi's fallback shows the first 10 lines of the output, and a guarded run's first lines are the top of the *kept tail* — the `[Showing lines … Full output: …]` summary sits below the cut.
- The duration lives in the row's own `context.state.runTimer` and is **frozen** at settle, so the header reads the same before and after the result. Never move it back into a module map keyed by `toolCallId`: Pi re-renders the call slot after the result, and the old `endRunTimer`-in-`finally` map had already dropped the start time — the settled row showed no duration at all.
- Collapsed: `previewLines` lines of code, each clipped at 120 columns (the `...` + reset downgrade that keeps the Box background). **Ctrl+O lifts both** — the whole command, unclipped. Result: the **tail** of the output, so the guard summary (spill path included) is always visible collapsed; Ctrl+O shows every line.
- The result body strips the child's own ANSI/CR before styling (`sanitizeProcessOutput`), which Pi's inherited body did for us. Skipping it tore the row: the child's mid-line `\x1b[0m` reset the Box background, so every value column drew black, and each CRLF line left a stray empty row. Mechanism: `docs/tool-rendering.md` §"truncateToWidth pitfalls".
- `previewLines` (the `/agent-run` setting, 1–50) governs both the command and the result preview.
- Exit code is in the tool text as `exit: N`, including the thrown error path. `details.exitCode` is not sent to the model.
- `bash` has no `cwd` and always uses the session directory. The role Footguns say to pass `cwd` on `pwsh` / `py`. Do not repeat that sentence in the tool schemas.
- Truncated tool outputs spill to a temp file; spills are cleaned on the next `session_start`.
- `pwsh` bootstraps `~/.pi/agent/profile.ps1` via `getAgentDir()` when present.
- Preview collapse and the other rendering settings are editable in a TUI: `/agent-run`.
