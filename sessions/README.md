# Sessions

Adds an interactive session picker for quickly switching between Pi sessions.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-sessions
```

## Usage

```text
/sessions [limit]
/sessions all [limit]
```

## Command

| Command | Description |
| --- | --- |
| `/sessions` | Pick a recent session from the current project. |
| `/sessions all` | Pick from sessions across all projects. |

## Behavior

- Lists recent sessions, sorted by modification time.
- Opens an interactive picker in TUI mode.
- Prints plain session lines in non-interactive mode.
- Switches to the selected session through Pi's session API.
- Supports an optional visible item limit.

## Settings

No extension-specific settings.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
