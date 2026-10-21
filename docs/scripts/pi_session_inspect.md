# `pi_session_inspect.py` — agent guide

Use this script to analyze Pi session logs and turn raw errors into an actionable report.

Related: **session lifecycle / cleanup** is `python scripts/session_triage.py` — see `docs/scripts/session_triage.md`. This file is health/forensics only.

## Related: mid-stream toolcall timing

Session JSONL has **final** assistant messages only. For live write/edit arg-stream lags, use **`stream-tool-log`**: read `~/.pi/agent/logs/stream-tool/INDEX.json` then `rg '"ev":"diag"'` (or `python scripts/stream_tool_log_report.py`). See `docs/extensions/stream-tool-log.md`.

## When to use

- After a batch of sessions, check overall agent health.
- Investigate why a specific tool keeps failing.
- Find stuck agent loops (repeated errors in one session).
- **Trace what the agent was thinking and doing around a specific event, file, or phrase.**
- Generate an action plan for improving prompts, tool usage, or workspace setup.

## Common commands

```bash
# Compact health report (messages, tool success rates, top errors, action plan)
python scripts/pi_session_inspect.py --summary --since 7 --json

# Inspect one specific session file (all cross-session flags work on it)
python scripts/pi_session_inspect.py /path/to/session.jsonl --summary --json
python scripts/pi_session_inspect.py /path/to/session.jsonl --all-errors --real-errors --json
python scripts/pi_session_inspect.py /path/to/session.jsonl --chains --real-errors --chain-length 3 --json

# All real errors with context, grouped by pattern, plus action plan
python scripts/pi_session_inspect.py --all-errors --real-errors --since 7 --json

# Only critical errors — fastest way to see what is actually broken
python scripts/pi_session_inspect.py --all-errors --real-errors --since 7 --min-severity critical --json

# Per-project health
python scripts/pi_session_inspect.py --project "10x001-domain" --summary --since 7 --json

# Detect repeated failures in one session
python scripts/pi_session_inspect.py --chains --real-errors --since 7 --chain-length 4 --json

# Model retry triggers (provider/model-level failures)
python scripts/pi_session_inspect.py --retries --since 7 --json

# Superseded full-read estimate (same path full-read more than once → freeable chars)
python scripts/pi_session_inspect.py --read-reuse --since 14
python scripts/pi_session_inspect.py --read-reuse --since 14 --json
python scripts/pi_session_inspect.py --read-reuse --since 14 --min-chars 4000
# same module, standalone:
python scripts/session_read_reuse.py --since 14 --json

# Prompt-cache behavior from assistant usage (LLM-first: prefer --json)
python scripts/session_cache_stats.py --since 14 --json
python scripts/session_cache_stats.py --since 7 --provider provider-a --json
python scripts/session_cache_stats.py --since 14 --model k3 --sessions
python scripts/session_cache_stats.py path/to/session.jsonl --json
# Report keys: by_kind, after_user_by_idle, after_idle_by_idle (fine TTL buckets),
# warm_window (3m–4m45s), warm_trigger, sessions[], contrast_sessions, insights.
# Affinity not in JSONL — A/B via --since windows or --provider only.

# Edit-specific failures with oldText samples
python scripts/pi_session_inspect.py --edit-errors --since 7

# Search for a phrase across all recent sessions, including agent reasoning
python scripts/pi_session_inspect.py --search "ProgramFiles" --since 7

# Show what the agent thought before/after a specific tool call or result
python scripts/pi_session_inspect.py --search "mklink" --tool bash --since 7 --reasoning-chain

# Narrow search to a single project and get structured output
python scripts/pi_session_inspect.py --project "10x001-prompts_dev" --search "PATH.*space" --since 7 --json
```

## Key flags

| Flag | Purpose |
|---|---|
| `--summary` | Health report: totals, tool success rates, insights, action plan. |
| `--all-errors` | Cross-session error report with analytics and patterns. |
| `--real-errors` | Filter common false positives (e.g. `bash` no-output exit 1, `read` section not found). |
| `--since DAYS` | Only sessions modified within the last N days. |
| `--recent N` | Only the N most recent sessions. |
| `--project NAME` | Filter by project folder (`--C--<NAME>--` in the sessions path). |
| `--category CAT` | Filter by error category, e.g. `bash_timeout`, `read_enoent`, `edit_old_string_not_found`. |
| `--tool TOOL` | Filter by tool name. |
| `--min-severity {info,warning,critical}` | Drop lower-severity errors. |
| `--chains` | Find consecutive failure sequences within a single session. |
| `--chain-length N` | Minimum length for a chain (default 3). |
| `--retries` | Report `a-retry-trigger` events (model/API retries). |
| `--search PATTERN` | Regex search across user prompts, assistant text/reasoning, tool-call arguments, and tool results. |
| `--context N` | Number of surrounding messages to show per search hit (default 2). |
| `--reasoning-chain` | For hits on tool calls/results, also show the assistant reasoning that led to the call and the reasoning that followed the result. |
| `--read-reuse` | Estimate bytes freeable by stubbing superseded full-file `read` results (same path, keep last). Implementation: `scripts/session_read_reuse.py`. |
| `--min-chars N` | With `--read-reuse`: ignore full-read results smaller than N chars (default 2000). |
| `--json` | Structured JSON output for another agent or script. |
| `--top N` | Limit output to top N patterns/errors (default 20). |
| `--no-context` | Skip user/assistant context around errors (faster). |
| `--fuzzy-groups` | Use fuzzy grouping for error patterns (slower, fewer groups). |
| `--noise REGEX` | Repeatable: treat matching error texts as noise. |
| `session` | Optional positional path to a single `.jsonl` session file. When given, all cross-session flags operate on only that file. |

## Session storage

Sessions are stored as `.jsonl` files under:

```
%USERPROFILE%\.pi\agent\sessions
```

Each project gets its own folder named `--C--<project>--`. The script discovers sessions automatically; you do not need to pass the full path unless you want to inspect one specific file.

## Search mode

`--search PATTERN` turns the inspector into a cross-session grep that also understands the conversation structure.

It searches through:

- user messages,
- assistant text and `thinking` / reasoning blocks,
- tool-call arguments,
- tool-result output,
- custom tool-timestamp metadata.

Combined with `--since`, `--project`, and `--tool` you can quickly narrow down the relevant moments. Use `--context N` to control how many surrounding messages are shown (default 2).

### Reasoning chains

Add `--reasoning-chain` when you want to reconstruct *why* the agent issued a command and how it reacted to the result. For hits that land on a tool call or tool result, the output includes:

- the assistant reasoning that immediately preceded the call,
- the call arguments,
- the matching result snippet,
- the assistant reasoning that followed the result.

This is the fastest way to answer questions like:

- "Why did the agent create `C:\tools\ProgramFiles`?"
- "What was it trying to fix when it ran `mklink /J`?"
- "How did it interpret the `Permission denied` error?"

### Search examples

```bash
# Find every mention of a file or path across recent sessions
python scripts/pi_session_inspect.py --search "C:\\tools\\ProgramFiles" --since 7

# Show reasoning around every bash invocation of a specific command
python scripts/pi_session_inspect.py --search "mklink" --tool bash --since 7 --reasoning-chain

# Look for where the agent discussed PATH problems
python scripts/pi_session_inspect.py --project "10x001-prompts_dev" --search "PATH.*space|unquoted PATH" --since 7 --reasoning-chain

# Structured output for further processing
python scripts/pi_session_inspect.py --search "ProgramFiles" --since 7 --json | jq '.hits[] | {line, role, tool, snippet}'
```

## Severity levels

| Level | Meaning | Example categories |
|---|---|---|
| `critical` | Agent logic or tool usage is wrong; fix is required. | `edit_old_string_not_found`, `bash_python_traceback`, `bash_ssh`, `grep_regex_error`, `bash_env_path_truncated`, `bash_pwsh_mangling`, `bash_quoting`, `python_escape_path` |
| `warning` | Environment or transient issue; check before retry. | `bash_timeout`, `read_enoent`, `bash_permission_denied`, `pwsh_cmdlet_not_found`, `pwsh_localization_missing_object` |
| `info` | Usually expected noise; safe to ignore in most reports. | `bash_no_output`, `read_section_not_found`, `bash_other` |

## JSON output shape

Both `--summary` and `--all-errors` include:

- `meta.command` — what you asked for.
- `insights` — short human-readable takeaways.
- `action_plan` — prioritized list of `{priority, action, reason, affected_category, count}`.

`--summary` adds:

- `totals` — sessions, messages, tool calls, errors.
- `tool_health` — calls/errors/success_rate per tool.
- `error_analytics` — counts by category/tool/severity/project.
- `sessions` — per-session stats.

`--all-errors` adds:

- `analytics` — same structure as `error_analytics`.
- `pattern_groups` — grouped similar errors with count and sample texts.
- `errors` — top individual errors with `result`, `call` args, and surrounding `context`.

## Inspect model reasoning for each error

`scripts/inspect_session_reasoning.py` is a small companion helper that pairs every failed tool result with:

- the assistant's **reasoning/thinking block** that follows the error,
- the **original tool-call arguments** that produced it.

Useful when the raw error text is not enough and you want to see how the model interpreted and attempted to recover from the failure.

```bash
python scripts/inspect_session_reasoning.py /path/to/session.jsonl
python scripts/inspect_session_reasoning.py /path/to/session.jsonl --tool bash --max-reasoning 2000
```

## How to act on results

1. Start with `--summary --since 3` to see tool health and top project.
2. If a tool has low success rate, run `--all-errors --tool <tool> --real-errors --json`.
3. If you see `critical` errors, read sample errors and context, then fix the root cause.
4. If one session has many errors, run `--chains` to identify stuck behavior.
5. To investigate a specific event, file, or agent decision, use `--search PATTERN --reasoning-chain`.
6. Feed `action_plan` back into your prompt/workflow improvements.
