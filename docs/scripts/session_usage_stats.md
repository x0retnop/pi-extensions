# `session_usage_stats.py` — agent guide

Rollup of `~/.pi/agent/sessions/*/*.jsonl` into "where did the month go" numbers, written as
**two files** (JSON + Markdown) so both a human and an agent can read the same run.

Related: `pi_session_inspect.py` = error/health forensics, `session_triage.py` = lifecycle/cleanup.
This file is spend, time and volume by plan / project / day. Read-only over the session tree; it
never writes into `~/.pi/agent`.

## Commands

```bash
python scripts/session_usage_stats.py                       # last 7 days -> reports/session-usage/
python scripts/session_usage_stats.py --week last           # ISO week (Mon-Sun)
python scripts/session_usage_stats.py --month last          # calendar month
python scripts/session_usage_stats.py --from 2026-09-01 --to 2026-09-30
python scripts/session_usage_stats.py --days 30 --project voxd
python scripts/session_usage_stats.py --week this --no-write        # one summary line, no files
python scripts/session_usage_stats.py --week this --print-md        # report to stdout
```

Default output dir is `reports/session-usage/` (gitignored). Each run writes
`usage-<from>_<to>.collected-<YYYY-MM-DDTHHMMSS>.{json,md}` — the name carries both the period and
the collection instant, so several runs over overlapping periods can coexist.

## Non-obvious

- **Nominal ≠ paid.** `nominalUSD` is the provider API-list price Pi records per assistant message
  (`usage.cost.total`); `paidUSD` is the subscription fee prorated over the window
  (`fee * days / 30.4375`). On a flat-rate plan overage does not become a bill — it shows up as a
  quota bar (`/usage`; see `docs/xai-grok-quota.md`, `docs/kimi-k3-quota.md`). `valueX` is the ratio
  the report leads with.
- **Plan registry lives in a private config file** next to the script, not in the code:
  `scripts/session-usage.config.json` (`plans`, `modelPlanOverrides`, `categories`), read at import;
  with no file the script runs on neutral example rows. Each plan is fee, label, Pi provider ids. Old Kimi provider names (`kimi-main-ant`,
  `kimi-builtin-anthrc`, `kimi-k3-builtin-anthrc`) are aliases of the same subscription. A provider
  with no plan lands in an `unmapped` row and is listed in `notes` — never silently folded into
  another plan. Changing a fee means editing that table.
- **Activity categories** (`CATEGORIES`, second registry at the top): project folder name →
  kind of work (`apps` / `harness` / `sys` / `experiments` / `games` / `media-gen` / `chats` /
  `personal`). Drives the `byCategory` section; a project with no mapping lands in `unmapped`
  and is listed in `notes` — same rule as plans. Sessions carry a `category` field. The
  `byCategoryModel` section is the activity × model cross (calls, share, nominal $).
- **`opencode` + `opencode-go` are one plan and stay on their own line.** This provider also carries
  a few non-DeepSeek models (kimi-k2.7-code, k3, glm) — by default they are billed to this plan
  because the provider is; move a model to another plan with `MODEL_PLAN_OVERRIDE`.
- **Window selection uses file mtime, activity is bucketed by message timestamp.** `/resume` appends
  to the *original* file, so its filename date stops matching its content (16 of 640 files have
  activity more than a day after their name). Selecting by filename date would drop that activity;
  the report counts it and flags resumed files per session (`resumedAfterStartHours`).
- **Active time comes from `ui-turn` records** (`ui-theme` turn log): sum of `endMs - startMs`.
  Span, pauses (>30 min gaps between messages) and idle hours sit next to it; span ≈ active + idle,
  and a session that was paused for hours is not "8 h of work". Sessions whose file predates the
  turn log have no `ui-turn`; their `activeHours` is 0 and
  `totals.activeCoverageSessions` tells you the share (611/640 files carry it).
- **Tool calls are counted once**: invocations from assistant `toolCall` blocks, failures from
  `toolResult.isError`. `wallSec` per tool is the sum of the per-call `durMs` recorded in `ui-turn`
  (a long `spawn_agent` wall time is the child agent's runtime, not overhead).
- **`cacheRead` is a volume, not a state**: the prompt cache re-reads summed over every call. A
  cache-read share above 90% of prompt tokens is normal here and is what makes list price survive at
  this volume.
- Timestamps are **local time** (UTC+3 on this host), from the epoch-ms fields in the records, not
  from filenames.
- Cost of the scan: one streaming pass, biggest line held in memory. Measured 1.8 s / 148 MB for a
  week, 6.1 s / 570 MB for a month, ~8 s for the whole 833 MB history. Nothing is loaded twice, so
  this is safe to run ad hoc.
- JSON shape is versioned in `meta.schema` (`meta.period`, `meta.scan`, `meta.costModel`, `plans`,
  `totals`, `latency`, `byDay`, `byWeek`, `byProject`, `byModel`, `byTool`, `sessions`, `notes`).
  `notes` carries the caveats that apply to that particular run (partial period, unmapped providers,
  active-time coverage) — read it before quoting a number.
