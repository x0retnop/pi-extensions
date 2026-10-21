# Development

Kept for the parts of Pi's own dev story that are not rediscoverable from the installed package.
The upstream page was removed in 1.0.1. This host runs Pi from the npm global CLI, so building from
source and Pi's own test suite do not apply.

## Debugging output

`logDirectory` is `getAgentDir()` (`~/.pi/agent`); the crash log falls back to the temp dir.

| Trigger | Writes to | Content |
|---|---|---|
| `/debug` (hidden command) | `~/.pi/agent/pi-debug.log` | every rendered TUI line with its visible width, then the agent messages as JSONL (`handleDebugCommand` → `getDebugLogPath()`) |
| `PI_TUI_DEBUG_REDRAW=1` | `~/.pi/agent/pi-tui-debug.log` | one line per full render: reason + previous/new line counts (scroll / redraw tracing) |
| `PI_TUI_DEBUG=1` | `/tmp/tui/render-<timestamp>.log` | raw rendered frames |
| width-overflow crash | `~/.pi/agent/pi-tui-crash.log` | the offending line and buffer |

## Fork / rebrand (unused here)

`package.json` → `piConfig: { name, configDir }` changes the CLI banner, config paths and env var
names. No fork is built on this host.
