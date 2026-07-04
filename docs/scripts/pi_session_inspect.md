# `pi_session_inspect.py` — agent guide

Use this script to analyze Pi session logs and turn raw errors into an actionable report.

## When to use

- After a batch of sessions, check overall agent health.
- Investigate why a specific tool keeps failing.
- Find stuck agent loops (repeated errors in one session).
- Generate an action plan for improving prompts, tool usage, or workspace setup.

## Common commands

```bash
# Compact health report (messages, tool success rates, top errors, action plan)
python scripts/pi_session_inspect.py --summary --since 7 --json

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

# Edit-specific failures with oldText samples
python scripts/pi_session_inspect.py --edit-errors --since 7
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
| `--json` | Structured JSON output for another agent or script. |
| `--top N` | Limit output to top N patterns/errors (default 20). |
| `--no-context` | Skip user/assistant context around errors (faster). |
| `--fuzzy-groups` | Use fuzzy grouping for error patterns (slower, fewer groups). |
| `--noise REGEX` | Repeatable: treat matching error texts as noise. |

## Severity levels

| Level | Meaning | Example categories |
|---|---|---|
| `critical` | Agent logic or tool usage is wrong; fix is required. | `edit_old_string_not_found`, `bash_python_traceback`, `bash_ssh`, `grep_regex_error` |
| `warning` | Environment or transient issue; check before retry. | `bash_timeout`, `read_enoent`, `bash_permission_denied` |
| `info` | Usually expected noise; safe to ignore in most reports. | `bash_no_output`, `read_section_not_found` |

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

## How to act on results

1. Start with `--summary --since 3` to see tool health and top project.
2. If a tool has low success rate, run `--all-errors --tool <tool> --real-errors --json`.
3. If you see `critical` errors, read sample errors and context, then fix the root cause.
4. If one session has many errors, run `--chains` to identify stuck behavior.
5. Feed `action_plan` back into your prompt/workflow improvements.
