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
- Asks before format/fix/build/test commands (in non-yolo modes).
- Asks before unknown commands (in non-yolo modes).
- Offers session-scoped approvals and resets them on `session_start` / `session_shutdown`.
- Keeps everyday agent work fast while still adding a guardrail around commands with side effects.

## Modes

Permission Gate supports four modes. The current mode is persisted in `~/.pi/agent/settings.json` and shown in the TUI status bar.

| Mode | Behavior |
|------|----------|
| `strict` | Safest — most commands require explicit confirmation. |
| `balanced` | Default-style allow list plus confirmations for risky commands. |
| `relaxed` | Optimized for coding-agent convenience. Auto-allows read-only package lookups, safe inline Python/Node, pipelines, and compounds while keeping hard blocks. |
| `yolo` | Minimal friction for active project work. Only hard blocks (e.g. `format`, `diskpart`, `rm -rf /`) and destructive operations (delete, install) still require confirmation; everything else passes freely. |

Switch modes at runtime with:

```text
/gate-mode strict
/gate-mode balanced
/gate-mode relaxed
/gate-mode yolo
```

Or check the current mode:

```text
/gate-mode
```

### Relaxed mode additions

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

It also auto-allows read-only-looking inline Python and Node.js patterns that agents commonly use for inspection, including:

```bash
python -c "from pathlib import Path; print(Path('file').read_text())"
python - <<PY
from pathlib import Path
print(Path('file').read_text())
PY
node -e "console.log('ok')"
node -p "process.version"
```

Inline scripts still ask when they appear to write/delete files, spawn subprocesses, perform network calls, or install packages.

### YOLO mode

`yolo` is meant for focused project work where the agent already knows the codebase and you want minimal interruptions. In this mode:

- **Auto-allowed**: builds, tests, formatters, Python scripts (`python path/to/script.py`), inline Python/Node, pipelines (`\|`), compounds (`&&`, `\|\|`), and unknown commands.
- **Still asks**: delete (`rm`, `del`, `Remove-Item`) and install (`npm install`, `pip install`, etc.).
- **Hard-blocked**: system-level destructive commands (`format`, `diskpart`, `git clean`, `rm -rf /`, etc.).

Approval choices

When a command needs confirmation, the prompt may offer:

- `Allow once`
- `Always allow exact command this session`
- `Always allow this kind this session`
- `Block`

For high-risk kinds such as install/delete/unknown/compound commands, broad kind-level session approval is intentionally not offered.

## Commands

| Command | Description |
|---------|-------------|
| `/gate-mode` | Show the current permission gate mode. |
| `/gate-mode strict` | Switch to strict mode. |
| `/gate-mode balanced` | Switch to balanced mode. |
| `/gate-mode relaxed` | Switch to relaxed mode. |
| `/gate-mode yolo` | Switch to yolo mode. |

## Customizing rules

Modes are persisted in `~/.pi/agent/settings.json` under `permissionGate.mode`. The allow/block/ask command patterns are defined in the extension source. Edit them carefully.

For safety, it is best to add or remove allowed commands with help from a strong LLM model, then manually review the resulting rules before using them. Small regex changes can make the gate too permissive or too annoying.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
