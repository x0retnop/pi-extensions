# Context

Show a compact overview of what Pi currently has loaded: context files, extensions, skills, active tools, and approximate token usage.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-context
```

## Commands

| Command | Description |
| --- | --- |
| `/context` | Open the context overview UI. |
| `/context-simple` | Alias for `/context`. |

## Behavior

- Lists project context files such as `AGENTS.md` and `CLAUDE.md`.
- Shows extension and skill commands that Pi has registered.
- Tracks skills that were loaded through `read` tool results.
- Estimates message, system prompt, and active tool tokens.
- Shows total session token/cost counters when available.

## Settings

No extension-specific settings.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
