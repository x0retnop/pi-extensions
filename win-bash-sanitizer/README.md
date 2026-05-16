# Win Bash Sanitizer

Sanitizes `bash` tool calls for Git Bash on Windows. Automatically fixes common Windows-to-Bash translation mistakes made by the model before execution.

## Install

```bash
pi install ./win-bash-sanitizer
```

## What it does

When the agent emits a `bash` tool call on Windows, this extension intercepts and cleans it up:

| Fix | Example |
| --- | --- |
| Strips `cmd` fallbacks | `ls ... 2>nul \|\| dir ...` → `ls ...` |
| Replaces `cmd` redirects | `2>nul` → `2>/dev/null` |
| Replaces `dir` with `ls` | `dir "path" /b` → `ls -1 'path'` |
| Converts Windows paths | `"C:\\Users\\name"` → `/c/Users/name` |
| Removes bad backslash escapes | `C:\\foo` → `C:/foo` |
| Blocks unbalanced quotes | Returns a block with guidance if quotes are still mismatched |

It also injects a lightweight ephemeral hint at `before_agent_start` to remind the model of Git Bash conventions without bloating the system prompt.

## Behavior

- No-op on non-Windows platforms (`process.platform !== "win32"`).
- Changes are notified via `ctx.ui.notify` so you can see what was rewritten.
- If quotes remain unbalanced after sanitization, the command is blocked and the model is asked to rewrite it.

## Compatibility

Tested with Git Bash on Windows. Works with Pi v0.72.1 or newer.
