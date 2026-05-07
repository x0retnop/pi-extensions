# Handoff

Create a focused handoff prompt from the current Pi session, then start a new session with that prompt pre-filled for review.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-handoff
```

## Usage

```text
/handoff <next task or goal>
```

Examples:

```text
/handoff finish the parser refactor
/handoff continue fixing the authentication bug
```

## Command

| Command | Description |
| --- | --- |
| `/handoff <goal>` | Extract useful session context and prepare a new focused session prompt. |

## Behavior

- Uses the current session conversation as source material.
- Extracts relevant files, commands, facts, decisions, risks, and next steps.
- Tracks the last invoked skill and includes it in handoff metadata when available.
- Starts a new session with the generated handoff prompt ready for the user to review and send.
- Uses the selected model or configured extraction model.

## Settings

Optional config can be loaded by the extension from project/user files when present. If no config is present, built-in defaults are used.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
