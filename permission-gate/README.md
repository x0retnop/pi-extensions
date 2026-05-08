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
- Asks before format/fix/build/test commands.
- Asks before unknown commands.
- Offers session-scoped approvals and resets them on `session_start` / `session_shutdown`.
- Keeps everyday agent work fast while still adding a guardrail around commands with side effects.

## Modes

The current mode is defined in source:

```ts
const CONFIG = {
  mode: "relaxed",
};
```

Supported modes are intended as:

- `strict` — safest / most prompts.
- `balanced` — default-style allow list plus confirmations for risky commands.
- `relaxed` — optimized for coding-agent convenience while keeping hard blocks.

At the moment the source is set to `relaxed`.

## Relaxed mode additions

In `relaxed` mode the gate also auto-allows common read-only package/library inspection commands, for example:

- `npm view`, `npm info`, `npm search`
- `pnpm view`, `pnpm info`, `pnpm why`, `pnpm list`
- `yarn info`, `yarn why`, `yarn list`
- `pip show`, `pip index versions`, `pip list`, `pip freeze`
- `python -m pip show`, `python -m pip index versions`, `python -m pip list`
- `uv pip show`, `uv pip list`
- `cargo search`, `cargo info`, `cargo metadata`, `cargo tree`
- `go list`
- `composer show`, `composer search`
- `gem info`, `gem search`, `gem list`

It also auto-allows read-only-looking inline Python patterns that agents commonly use for inspection, including:

```bash
python -c "from pathlib import Path; print(Path('file').read_text())"
python - <<PY
from pathlib import Path
print(Path('file').read_text())
PY
```

Inline Python still asks when it appears to write/delete files, spawn subprocesses, perform network calls, or install packages.

## Approval choices

When a command needs confirmation, the prompt may offer:

- `Allow once`
- `Always allow exact command this session`
- `Always allow this kind this session`
- `Block`

For high-risk kinds such as install/delete/unknown/compound commands, broad kind-level session approval is intentionally not offered.

## Commands

No slash commands.

## Customizing rules

There is no external settings file. The mode and allow/block/ask command patterns are defined in the extension source. Edit them carefully.

For safety, it is best to add or remove allowed commands with help from a strong LLM model, then manually review the resulting rules before using them. Small regex changes can make the gate too permissive or too annoying.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
