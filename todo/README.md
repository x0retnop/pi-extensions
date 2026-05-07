# Todo

Adds a model-callable todo checklist tool for larger coding tasks, plus commands for viewing and controlling when the tool is available.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-todo
```

## Commands

| Command | Description |
| --- | --- |
| `/todos` | Show todos on the current branch. |
| `/todo-mode auto` | Enable the todo tool only when the prompt looks like larger work. |
| `/todo-mode on` | Keep the todo tool enabled. |
| `/todo-mode off` | Keep the todo tool disabled. |
| `/todo-mode status` | Show the current todo mode. |

## Tool

| Tool | Description |
| --- | --- |
| `todo` | Optional planning checklist for large changes, broad refactors, migrations, or multi-step tasks. |

Supported tool actions include `list`, `replace`, `add`, `update`, `toggle`, and `clear`.

## Behavior

- Defaults to avoiding todo use for small tasks.
- In `auto` mode, enables the tool for explicit checklist requests or larger/refactor-style prompts.
- Stores todo state in tool result details so it follows session history and branch navigation.
- Renders todo calls/results with compact custom UI.
- Keeps one active item convention through tool guidance, but the model controls the actual list updates.

## Settings

No external settings file. Use `/todo-mode auto|on|off|status`.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
