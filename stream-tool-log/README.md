# stream-tool-log

Logs how write/edit arguments arrive mid-stream. You only turn it on and off. Agents read the files.

## You

1. Copy this folder to `~/.pi/agent/extensions/stream-tool-log/`
2. Restart Pi
3. `/streamlog` — toggle. Or `/streamlog on` / `/streamlog off`

Footer `stl` = recording. Off by default (nothing written). On/off survives restart.

## Not you

Logs and how to read them: `docs/extensions/stream-tool-log.md`. Agents start at `~/.pi/agent/logs/stream-tool/INDEX.json`.
