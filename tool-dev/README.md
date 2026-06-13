# tool-dev

Developer commands for inspecting what tools are registered and visible to the LLM.

## Commands

- `/tools` — Show only the tools currently active (sent to the LLM).
- `/tools-all` — Show all registered tools with full schemas, source, and active/inactive status.

Both commands write the output to a temp markdown file and paste the path into the editor.

## Install

Copy the extension folder to `~/.pi/agent/extensions/` and restart Pi.
