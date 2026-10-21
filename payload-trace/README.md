# payload-trace — manual full payload capture

On-demand dumper for **everything sent to / received from the LLM provider**.
OFF by default — nothing is written until you run `/payload-trace start`.

## What it captures

While ON, each provider call produces:

| File | Content |
|------|---------|
| `req-<seq>-<ts>.json` | FULL request payload as built by pi (`before_provider_request`): system prompt, tools, messages |
| `resp-<seq>-<ts>.json` | FULL parsed response (`turn_end`): text, thinking, tool calls, usage, stopReason + toolResults |
| `trace.jsonl` | Compact per-event join: seq · provider/model · sys/tools/roles hashes · headers (`x-session-affinity`/`x-session-id`) · HTTP status per attempt (retries included) · tokens/cacheRead/miss |

Location: `~/.pi/agent/logs/payload-trace/cap-<ts>-<pid>/` — one folder per activation,
timestamped name (pid guards against parallel Pi processes).

## Commands

```
/payload-trace start    — open a capture folder, notify in chat
/payload-trace stop     — close it, report path + call/byte counts in chat
/payload-trace status   — current state (on/off, dir, counts)
```

Analysis of the dumps is a separate step (Python parser script) — the dumps are
raw JSON on purpose.

## Notes

- Read-only: never mutates payload/headers/response; every handler is wrapped so
  a capture error can never break the request path.
- Retries: `before_provider_headers` / `after_provider_response` fire per HTTP
  attempt for the same request seq — trace records each status.
- Sub-agent processes run without this extension — main session only.
- The old always-on hashing/cache-miss logger was removed in favor of this
  manual mode (start it when you need it, not all the time).
