# payload-trace

Manual, on-demand full payload capture: dumps everything sent to / received from the LLM provider.

## What it does

OFF by default — zero writes. `/payload-trace start` opens a timestamped capture folder
(`~/.pi/agent/logs/payload-trace/cap-<ts>-<pid>/`) and, per provider call, writes:

- `req-<seq>-<ts>.json` — full request payload (system + tools + messages), captured at `before_provider_request`;
- `resp-<seq>-<ts>.json` — full parsed response (`turn_end` AgentMessage: text, thinking, tool calls, usage, stopReason, toolResults);
- `trace.jsonl` — compact join records: seq · provider/model · sys/tools/roles sha256 · `x-session-affinity`/`x-session-id` headers · HTTP status per attempt (retries included) · tokens/cacheRead/miss flag.



## Important behaviors

- Read-only on payload/headers/response; every handler is wrapped — a capture error can never break the request path.
- Retries: `before_provider_headers` / `after_provider_response` fire per HTTP attempt for the same request seq; each status is recorded.
- Dumps are raw JSON — analysis is a separate step (Python parser script), not this extension's job.
- **Weighing the fixed prefix.** `req-*.json` is the cheapest way to see what every request pays before
  any conversation: `tools` vs `messages[0].content` (system). Measured 2026-09-20 on 12 tools:
  tools 18.5 KB, system 5.0 KB → ~6k tokens of constant prefix, ~78 % of it the tool schema. Only
  removing tools shrinks it; descriptions are cached with the prompt prefix, so this is a context
  budget cost more than a price cost.
- Sub-agent processes run without this extension — main session only.
- Removed the old always-on hashing/cache-miss logger (kimi cache-miss research is done); capture is now explicitly manual. Facts from that investigation: `docs/research/kimi-cache-miss-research.md` (dump, not a guide).
