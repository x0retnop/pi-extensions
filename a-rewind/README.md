# A Rewind

Automatically catches a common failed-assistant pattern in Pi: when the assistant says it will use tools, but does not emit an actual structured tool call. It can ask Pi to retry with a stricter instruction, and also provides a manual rewind command for the latest assistant message.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-a-rewind
```

## Commands

| Command | Description |
| --- | --- |
| `/a-rewind-auto on` | Enable automatic guard mode. |
| `/a-rewind-auto off` | Disable automatic guard mode. |
| `/a-rewind-auto status` | Show whether automatic guard mode is enabled. |
| `/a-rewind-last` | Rewind the current session to before the latest assistant message. |

## Behavior

- Watches assistant messages for tool-use preambles without real tool calls.
- In auto mode, injects a retry instruction and filters the failed assistant output from the next model context.
- Persists the auto-mode setting in the session.
- Adds a small status/widget indicator when available.
- Ignores unexpected message-shape errors inside the `message_end` handler so the guard does not interrupt Pi event processing.

## Marker format

Internal hidden/filter markers intentionally use single-bracket strings such as `[a-rewind:...]`. Avoid changing them to double-bracket marker strings, because some harness/output paths may suppress those strings.

## Settings

No file-based settings. Use `/a-rewind-auto on|off|status`.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
