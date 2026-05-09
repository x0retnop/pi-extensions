# BTW

Ask quick side questions in Pi without adding them to the current conversation.

BTW adds a `/btw` command for short, read-only questions about the current session context. It sends the existing conversation to the currently selected model, shows the answer in a temporary overlay, and does not persist the question or answer in the session history.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-btw
```

## Usage

```text
/btw <question>
```

Examples:

```text
/btw what files did we change?
/btw why did we choose this approach?
/btw remind me what the current bug is
```

## Command

| Command | Description |
| --- | --- |
| `/btw <question>` | Ask a side question using the current conversation as context. The answer is shown outside the main chat history. |

## Behavior

- Uses the currently selected Pi model.
- Has no tool access; it cannot read files, run commands, or edit anything.
- Answers only from the existing conversation context.
- Bounds very large conversation input by keeping the beginning and recent tail.
- Shows a scrollable overlay in interactive mode.
- Prints the answer to stdout in non-interactive mode.
- Does not write the question or answer to the session history.

## Overlay controls

| Key | Action |
| --- | --- |
| `Esc`, `q`, `Space`, `Ctrl+C` | Close overlay |
| `↑` / `↓` or `k` / `j` | Scroll |
| `PgUp` / `PgDn` | Page scroll |

## Settings

No extension-specific settings.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
