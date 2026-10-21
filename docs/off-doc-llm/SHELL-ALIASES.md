# Shell Commands
> Adapted from bundled docs `shell-aliases.md` (Pi 1.0.1; the installed package wins if they disagree).

Pi starts a separate non-interactive shell process for each Bash command. Non-interactive Bash does not expand aliases by default, and usually does not load the same startup files as an interactive terminal.

`shellPath` chooses the Bash executable. `shellCommandPrefix` runs setup before each command.

## Understand which shell Pi uses

| Command source | Shell |
|---|---|
| Model calls the built-in `bash` tool | Pi's resolved Bash executable |
| `!command` or `!!command` | The same resolved Bash executable |
| Model calls the optional `powershell` tool | PowerShell 7 (`pwsh.exe`) or Windows PowerShell |
| An extension provides or replaces a shell tool | The operations that extension implements |

Pi normally invokes Bash with `bash -c`.

| Platform | Resolution order |
|---|---|
| Unix | `/bin/bash`, then `bash` on `PATH`, then `sh` when Bash is unavailable |
| Native Windows | Configured path, then Git Bash, then `bash.exe` on `PATH` |

## Choose a Bash executable

Set `shellPath` in `~/.pi/agent/settings.json` when Pi should use a specific executable:

```json
{
  "shellPath": "~/.local/bin/bash"
}
```

On Windows, forward slashes or escaped backslashes:

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

`/reload` after changing the setting. Native Windows defaults: `windows.md`.

## Run setup before every Bash command

`shellCommandPrefix` is prepended to the built-in `bash` tool and to user-entered `!` or `!!` commands. Pi joins the prefix and the requested command with a newline. The prefix runs again for every command. Keep it fast and free of interactive prompts.

```json
{
  "shellCommandPrefix": "export CI=1"
}
```

## Enable Bash aliases

Store aliases Pi needs in a Bash-compatible file. Do not parse an entire interactive shell configuration.

`~/.bash_aliases`:

```bash
alias ll='ls -la'
alias gs='git status --short'
```

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\nsource ~/.bash_aliases"
}
```

`/reload`, then `!ll`. It should produce the same listing as `ls -la`.

Aliases must use Bash-compatible syntax. Do not source an arbitrary `.zshrc` into Bash. zsh options, functions, and plugins may not parse or behave correctly there.

## Troubleshooting

### The prefix works for ! but not for an extension tool

`shellCommandPrefix` configures Pi's built-in Bash execution. An extension that replaces the `bash` tool, or that provides its own shell operations, controls its own setup. Check that extension's documentation.

### shopt is not found

Pi fell back to `sh`, or `shellPath` points at a non-Bash shell. Install Bash, or set `shellPath` to a Bash executable, before Bash-specific setup such as `shopt`.

### A setup command waits for input

Remove interactive commands from `shellCommandPrefix`. The prefix runs in a non-interactive process before every Bash command.

Setting definitions: `settings.md` (Shell settings).
