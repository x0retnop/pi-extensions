# pi-extension-list-tools

Meta-tool that returns the full catalog of every available tool, grouped by source, with active/inactive status and parameter summaries.

## Tool

- `list_my_tools` — returns a markdown list of all tools the agent can use.

## Install

Copy the extension folder to `~/.pi/agent/extensions/` and restart Pi.

## Output format

```markdown
# Available tools (N active of M total)

## Built-in tools
- **read** (active) — Read file contents...
  - `path` (string, required) — File path to read.

## pi-extension-grep-tool
- **grep** (active) — Fast structured search via ripgrep.
  - `pattern` (string, required) — Regex or literal search pattern.

## Inactive (available but not currently enabled)
- **some_tool** (inactive) — ...
```

## Notes

- The tool excludes itself from the listing.
- `parameters` is empty — the tool takes no arguments.
