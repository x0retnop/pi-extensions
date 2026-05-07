# Context Manager

Manual context helper for Pi. It shows context usage, can toggle a persistent status indicator, and provides manual handoff/compaction helpers without automatically compacting your session.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-ctx-manager
```

## Commands

| Command | Description |
| --- | --- |
| `/ctx` | Show current context usage and session stats. |
| `/ctx clear` | Clear the context-manager widget/status output. |
| `/ctx-status` | Show current footer status mode. |
| `/ctx-status on` | Enable persistent context status. |
| `/ctx-status off` | Disable persistent context status. |
| `/ctx-compact [instructions]` | Manually trigger Pi compaction with default or custom instructions. |
| `/ctx-handoff [goal]` | Ask the current model to write a handoff prompt in the normal chat. |
| `/ctx-handoff-lite [goal]` | Build a lightweight local handoff draft in a separate editor window. |

## Behavior

- Does not compact automatically.
- Does not replace Pi's footer; it uses status/widget output.
- `/ctx-handoff` uses the current model and conversation.
- `/ctx-handoff-lite` builds a cheaper local draft from recent session entries.

## Settings

No external settings file. Defaults are defined in the extension source.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
