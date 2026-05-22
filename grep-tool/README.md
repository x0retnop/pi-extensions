# Grep Tool

Adds a model-callable `grep` tool powered by ripgrep. Faster, safer, and easier to parse than raw shell grep.

## Install

```bash
pi install ./grep-tool
```

## Tool

| Tool | Description |
| --- | --- |
| `grep` | Structured search via ripgrep. Respects `.gitignore`, supports glob/type filters, context lines, case-insensitive search, and multiple output modes. |

## Behavior

- Searches using `rg --json` for structured output.
- Falls back to known Windows install paths if `rg` is not on `PATH`.
- Supports `content`, `files_with_matches`, and `count_matches` output modes.
- Limits results with `head_limit` to avoid flooding the context window.
- Handles missing `rg` and empty results gracefully.

## Settings

No external settings file. Ensure `rg` is installed and available on `PATH`.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Maintenance

See [`AGENTS.md`](../AGENTS.md) for open tasks.
