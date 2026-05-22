# @vinyroli/pi-tool-codex

Compact tool, diff, and status rendering for the [Pi coding agent](https://github.com/mariozechner/pi).

`@vinyroli/pi-tool-codex` reduces transcript noise, improves `edit` and `write` presentation, refines core chat UI details, and adds configuration controls designed for day-to-day TUI usage.



## Features

- Compact rendering for `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`
- MCP tool rendering with `hidden`, `summary`, and `preview` modes
- `edit` and `write` diffs with Codex-style unified layout by default in `auto`, plus forced `split` and `unified` modes
- Collapsed diff hints that automatically shrink on narrow terminals
- Inline `write` summaries with line counts and byte sizes
- Execution status bullets and more compact final result headers
- Thinking and interruption labels, with sanitization so presentation markers do not leak into future turns
- Assistant message styling improvements, including blank-line compaction and consistent accents for headings, lists, and inline code
- Interactive working timer with elapsed time and a separator before the assistant's final visible reply
- Optional native user message box with safer markdown rendering
- Capability-aware settings modal that hides MCP and RTK options when unavailable
- Per-tool ownership controls so this extension can coexist with other renderers

## Installation

### Local extension folder

Place this repository in one of Pi's auto-discovery locations:

```text
# Global (when PI_CODING_AGENT_DIR is not set)
~/.pi/agent/extensions/pi-tool-codex

# Project-specific
.pi/extensions/pi-tool-codex
```

### npm package

```bash
pi install npm:@vinyroli/pi-tool-codex
```

### Git repository

```bash
pi install git:github.com/vinyroli/pi-tool-codex
```

## Usage

Open the interactive modal:

```text
/tool-view
```

Direct commands:

```text
/tool-view show
/tool-view reset
/tool-view preset opencode
/tool-view preset balanced
/tool-view preset verbose
```

The modal covers the settings most people adjust regularly:

- active preset
- `read` output mode
- `grep`/`find`/`ls` output mode
- MCP output mode, when available
- preview line count
- collapsed line count for `bash`
- diff layout
- diff indicators
- collapsed diff line count
- native user message box toggle

Advanced options remain available in `config.json`.

## Presets

| Preset     | Read Output | Search Output | MCP Output | Bash Output | Preview Lines | Bash Lines |
| ---------- | ----------- | ------------- | ---------- | ----------- | ------------- | ---------- |
| `opencode` | hidden      | hidden        | hidden     | opencode    | 8             | 10         |
| `balanced` | summary     | count         | summary    | summary     | 8             | 10         |
| `verbose`  | preview     | preview       | preview    | preview     | 12            | 20         |

- `opencode`: minimal transcript focused on headers and collapsed results
- `balanced`: compact summaries with counts and moderate previews
- `verbose`: more inline context for reads, searches, MCP, and shell output

## Configuration

Runtime configuration lives at:

```text
~/.pi/agent/extensions/pi-tool-codex/config.json
```

If `PI_CODING_AGENT_DIR` is set, the global path respects that directory. When `pi-tool-codex/config.json` does not exist yet, the extension also falls back to legacy paths such as `pi-tool-view/config.json` and `pi-tool-display/config.json`.

A starter template is available at `config/config.example.json`.

### Options

| Option                       | Type    | Default      | Description                                                  |
| ---------------------------- | ------- | ------------ | ------------------------------------------------------------ |
| `registerToolOverrides`      | object  | all `true`   | Defines which built-in tools this extension owns             |
| `enableNativeUserMessageBox` | boolean | `true`       | Enables the native bordered user message box                 |
| `readOutputMode`             | string  | `"hidden"`   | `hidden`, `summary`, or `preview`                            |
| `searchOutputMode`           | string  | `"hidden"`   | `hidden`, `count`, or `preview`                              |
| `mcpOutputMode`              | string  | `"hidden"`   | `hidden`, `summary`, or `preview`                            |
| `previewLines`               | number  | `8`          | Number of lines shown in collapsed previews                  |
| `expandedPreviewMaxLines`    | number  | `4000`       | Max line count when an expanded preview is opened            |
| `bashOutputMode`             | string  | `"opencode"` | `opencode`, `summary`, or `preview`                          |
| `bashCollapsedLines`         | number  | `10`         | Line budget for `bash` in `opencode` mode                    |
| `diffViewMode`               | string  | `"auto"`     | `auto`, `split`, or `unified`                                |
| `diffIndicatorMode`          | string  | `"bars"`     | `bars`, `classic`, or `none`                                 |
| `diffSplitMinWidth`          | number  | `120`        | Field kept in normalized config for tuning and compatibility |
| `diffCollapsedLines`         | number  | `24`         | Number of visible lines before a diff collapses              |
| `diffWordWrap`               | boolean | `true`       | Wraps long diff lines                                        |
| `showTruncationHints`        | boolean | `false`      | Shows truncation hints for compacted output                  |
| `showRtkCompactionHints`     | boolean | `false`      | Shows RTK compaction hints when metadata is available        |

### Tool ownership

Use `registerToolOverrides` to choose which renderers this extension controls:

```json
{
  "registerToolOverrides": {
    "read": true,
    "grep": true,
    "find": true,
    "ls": true,
    "bash": true,
    "edit": true,
    "write": true
  }
}
```

Set any entry to `false` if another extension should render that tool instead.

> Ownership changes take effect after `/reload`.

### Example

```json
{
  "registerToolOverrides": {
    "read": true,
    "grep": true,
    "find": true,
    "ls": true,
    "bash": true,
    "edit": true,
    "write": true
  },
  "enableNativeUserMessageBox": true,
  "readOutputMode": "summary",
  "searchOutputMode": "count",
  "mcpOutputMode": "summary",
  "previewLines": 12,
  "expandedPreviewMaxLines": 4000,
  "bashOutputMode": "opencode",
  "bashCollapsedLines": 15,
  "diffViewMode": "auto",
  "diffIndicatorMode": "bars",
  "diffSplitMinWidth": 120,
  "diffCollapsedLines": 24,
  "diffWordWrap": true,
  "showTruncationHints": false,
  "showRtkCompactionHints": false
}
```

## Rendering Notes

### `edit` and `write` diffs

`edit` and `write` share the same diff pipeline. In `auto` mode, the current presentation prioritizes a single-column unified patch, with compact fallbacks when the available width gets too small. `split` mode remains available when you want forced side-by-side comparison.

### Inline `write` metrics

When `write` content is available, the tool header includes lines and bytes before the result is expanded. That makes it easier to validate the size of a pending write at a glance.

### Thinking, interruption, and assistant messages

Thinking blocks receive labels during streaming and in final output. Default abort messages such as `Request was aborted` or `Operation aborted` are converted to `■ Conversation interrupted`, and UI-added markers are sanitized before going back into persisted context.

Assistant messages also receive a light visual patch: headings become easier to scan, list markers and inline code get a consistent accent, and redundant blank lines are removed.

### Working timer and separator

In interactive mode, the working state shows elapsed time in compact form, for example `Working (1m 01s • esc to interrupt)`. After tools run and the assistant starts replying with visible text, the extension inserts a visual rule to separate the work block from the final answer.

### Native user message box

When enabled, user prompts render inside a bordered box using Pi's native component. The renderer avoids common ANSI and nested background artifacts and preserves markdown more safely.

### Automatically detected capabilities

- Without MCP tooling: MCP mode is forced to `hidden` and related controls disappear from the modal
- Without RTK optimizer: RTK compaction hints remain unavailable

## Troubleshooting

### Renderer conflicts with other extensions

If another extension already renders a supported tool:

1. Set `registerToolOverrides.<tool>` to `false`
2. Run `/reload`
3. Use `/tool-view show` to inspect the effective configuration

### Configuration is not loading

Check:

1. Whether `config.json` contains valid JSON
2. Whether the file is in the correct Pi directory
3. Whether `/tool-view show` reflects the values you expect

### MCP or RTK options are missing

Those controls only appear when the current Pi session exposes the corresponding capabilities.

## Project Structure

- `index.ts` and `src/index.ts`: entrypoint and extension bootstrap
- `src/tool-overrides.ts`: built-in tool rendering and MCP wrappers
- `src/diff-renderer.ts`, `src/diff-presentation.ts`, and `src/line-width-safety.ts`: diff pipeline, layout, and overflow protection
- `src/config-store.ts`, `src/config-modal.ts`, and `src/settings-inspector-modal.ts`: config persistence and settings UI
- `src/assistant-message-style.ts`, `src/thinking-label.ts`, `src/interruption-label.ts`, and `src/working-status-timer.ts`: assistant message and interactive-flow patches
- `src/user-message-box-*.ts`: native user message box rendering and patching
- `tests/*.test.ts`: focused regressions for rendering, status, capability detection, and normalization
- `config/config.example.json`: starter configuration

## Development

Requirements:

- Node `>=20`

Main commands:

```bash
npm install
npm run build
npm run test
npm run check
```

## Credits

- Derived from: [pi-tool-display](https://github.com/MasuRii/pi-tool-display)
- This repository is an independently maintained derivative, not a formal GitHub fork in the fork network.
