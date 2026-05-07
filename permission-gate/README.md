# Permission Gate

Adds an interactive safety gate for `bash` tool calls. It is tuned for normal agent work: common read-only inspection commands can pass without friction, while risky commands are blocked or require confirmation.

This extension is meant to support a safe, practical workflow for coding agents. It works especially well together with an `AGENTS.md` file that tells the agent how to work, when to ask, and which local safety rules to follow.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-permission-gate
```

## Behavior

- Auto-allows common read-only commands such as search/list/status style commands.
- Blocks clearly dangerous system-level commands.
- Asks before install/update/remove commands.
- Asks before delete commands.
- Asks before format/fix/build/test commands and inline Python commands.
- Asks before unknown commands.
- Allows some approval types for the current session when the prompt offers that option.
- Keeps everyday agent work fast while still adding a guardrail around commands with side effects.

## Commands

No slash commands.

## Customizing rules

The allow/block/ask command patterns are defined in the extension source. Edit them carefully.

For safety, it is best to add or remove allowed commands with help from a strong LLM model, then manually review the resulting rules before using them. Small regex changes can make the gate too permissive or too annoying.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
