# Pi Docs Toggle

Removes the hard-coded Pi documentation block from the system prompt by default,
preventing it from leaking into the conversation on accidental mentions.

Provides a session-only toggle command to temporarily re-enable the block when you
actually need to work on Pi internals, extensions, themes, or TUI.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-pi-docs-toggle
```

Or copy the extension folder into your project or global Pi extensions directory.

## Commands

| Command | Description |
| --- | --- |
| `/pi_docs` | Toggle the Pi documentation block on/off (cycles: off → on → off). |

## Behavior

- **Default:** The Pi documentation block is stripped from every system prompt.
- **Toggle:** Running `/pi_docs` flips the state for the current session only.
- **No persistence:** The setting is not saved to `settings.json`; each new session starts with the block **off**.

## Reliability & Self-Check

The extension uses **two levels** of regex to strip the block:

1. **Exact match** — targets the current known block text (including the final bullet).
2. **Fallback match** — softer boundary detection using the header and last known bullet patterns.

If Pi updates and changes the hard-coded text so that **neither regex removes the block**, the extension performs a self-check:

- It detects that the `Pi documentation` keyword is still present after stripping.
- It shows a **single warning per session** via the Pi TUI notification area:
  > `[pi-docs-toggle] Warning: Pi documentation block detected but could not be stripped. The regex may need updating for this pi version.`
- The warning appears as a standard yellow/orange toast notification in the terminal UI.
- Starting a new session (`/new`, `/resume`, `/fork`) resets the warning guard so you will be alerted again if the issue persists.

**What to do if you see the warning:**
1. Check which Pi version you are running (`pi --version`).
2. Open an issue on the extension repository with the version number — the regex will be updated.
3. As a temporary workaround you can place a custom `.pi/SYSTEM.md` to override the default prompt entirely.

## Settings

No file-based settings. Use `/pi_docs` to control the block on a per-session basis.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
