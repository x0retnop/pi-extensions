# Protected Paths

Protects files outside the active project and sensitive system/user locations from accidental reads or writes by Pi tools.

This extension is tuned for normal agent work: agents can operate inside the current project with low friction, but reads/writes outside the project and suspicious path usage get blocked or require confirmation. It works especially well together with an `AGENTS.md` file that tells the agent to stay project-local and avoid broad or destructive filesystem actions.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-protected-paths
```

## Behavior

- Blocks Pi when it is started from a too-broad directory such as the drive root or home folder.
- Allows normal file access inside the current project.
- Requires stronger confirmation before writing or editing files outside the current project.
- Blocks hard-destructive bash commands.
- Blocks suspicious write-like bash commands with path traversal.
- Asks before bash commands that may write to protected or external paths.
- Helps keep agent writes scoped to the active project while allowing practical inspection work.

## Modes

The current mode is defined in source:

```ts
const CONFIG = {
  mode: "relaxed",
};
```

Supported modes are intended as:

- `strict` — safest / most prompts.
- `balanced` — project-local reads/writes are low friction, external reads ask.
- `relaxed` — ordinary external reads are allowed, but writes and sensitive roots remain protected.

At the moment the source is set to `relaxed`.

## Relaxed mode behavior

In `relaxed` mode, ordinary `read` tool access outside the current project is allowed without prompting. This is meant to reduce friction when inspecting:

- installed libraries and SDKs;
- package manager caches;
- documentation files;
- adjacent local repositories or examples;
- language/runtime files needed to understand APIs.

Sensitive/system roots are still protected, including:

- `.ssh`
- `.pi`
- `.config`
- `C:/Windows`
- `C:/Program Files`
- `C:/Program Files (x86)`
- `C:/ProgramData`

Writes/edits outside the active project still require double confirmation.

## Session read approvals

When an external read still needs confirmation, the prompt can allow:

- one read;
- the containing directory for the current session;
- blocking the read.

Session approvals reset on `session_start` / `session_shutdown`.

## Commands

No slash commands.

## Customizing paths

There is no external settings file. The mode, protected roots, trusted read roots, and path checks are defined in the extension source. Edit them carefully.

For safety, it is best to add or remove allowed/protected paths with help from a strong LLM model, then manually review the resulting rules before using them. Path matching mistakes can accidentally allow writes outside the intended project scope.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
