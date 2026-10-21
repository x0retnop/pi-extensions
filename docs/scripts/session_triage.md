# `session_triage.py` — agent guide

Classify `~/.pi/agent/sessions` without dumping the file list into chat.

`pi_session_inspect.py` is health/forensics. This script is lifecycle: empty/stub/cancelled vs historical meat.

Aged-out sessions (≥45d, minus each project's 3 freshest) may already have been **moved out** by `hist archive build` into `C:\10x001\archive\pi-sessions\` — this script only sees what is still live. Old threads live there: `hist archive search|show|list` (see `C:\tools\hist\skill.md`).

## Non-obvious

- Session JSONL on disk starts with `type: "session"` (not the docs' `header`). There is no display `name` field to trust.
- Large / busy sessions in a dead or `_temp` cwd stay in **review**, never auto-junk. Historical value is the whole point.
- Apply **quarantines** (move to `~/.pi/agent/sessions-quarantine/`). Restore is a move back. `--delete` is explicit and extra.
- Files newer than `--protect-hours` (default 24) are skipped on apply — do not pick up the live session.
- Default text and `--json` (no `--out`) are rollups only. Full per-session records exist only in `--out` JSON. Do not cat that file into the conversation.
- The buckets only flag short sessions in scratch/dead cwds. A short session in a **live** project stays `keep` — that blind spot is what `--highlights short` covers, and it judges by **size, not the opener prompt** (the user's openers vary).
- `--rollup stale` is the per-project age table; the actionable pair is old **and** `cwd=dead`. Old with `cwd=alive` is a project that just runs rarely — the user decides, not the script.

## Commands

```bash
python scripts/session_triage.py
python scripts/session_triage.py --json --out _scratch/session-triage.json
python scripts/session_triage.py --list junk
python scripts/session_triage.py --highlights scratch
python scripts/session_triage.py --highlights scratch --sort meat
python scripts/session_triage.py --highlights short            # tiny/broken, ANY project, size-ranked
python scripts/session_triage.py --highlights short --max-bytes 30000 --top 40
python scripts/session_triage.py --highlights short --sort date
python scripts/session_triage.py --rollup age
python scripts/session_triage.py --rollup month
python scripts/session_triage.py --rollup stale                # old per project, cwd aware
python scripts/session_triage.py --project "10x001-noteai-dev" --older 90        # dry-run old ones
python scripts/session_triage.py --project "10x001-noteai-dev" --older 90 --apply
python scripts/session_triage.py --project "pi extensions" --rollup git
python scripts/session_triage.py --project "pi extensions" --apply --drop-topic dead
python scripts/session_triage.py --highlights scratch --top 30
python scripts/session_triage.py --apply --drop-session path/to/session.jsonl
python scripts/session_triage.py --apply --bucket junk
python scripts/session_triage.py --apply --bucket likely
python scripts/session_triage.py --drop-project "temp-html"          # dry-run one project
python scripts/session_triage.py --apply --drop-project "temp-html" --drop-project "tmp"
python scripts/session_triage.py --restore          # dry-run
python scripts/session_triage.py --restore --apply
```

## Buckets

| Bucket | Meaning | Apply? |
|---|---|---|
| `junk` | unreadable / empty / no user / aborted / stub prompt (`hi`, `test`, `/axi on`, ping) and tiny | yes |
| `likely` | scratch cwd (`_temp`, `tmp`, `-eval`, …) or missing cwd, and still small | only if the project names look right |
| `review` | scratch/orphan **but meaty** (size / users / tools / compaction) | no — ask |
| `keep` | everything else | never |

Meaty threshold: ≥80 KB or ≥4 user turns or ≥5 tool calls. Stub ceiling: ≤12 KB, ≤1 user, 0 tools.

## Agent workflow

1. Run with no flags. Read the rollup (counts, MB, top projects, all-junk projects).
2. If junk is obvious, `--apply --bucket junk`. Tell the user the moved count + quarantine path.
3. Cancelled/test **projects** are the decision unit — ask the user by project name, then `--apply --drop-project NAME`. That includes review meat in that folder.
4. Scratch folders are mixed. `--highlights scratch` lists leftover temp/test sessions. Default sort is **date** (`2026 08 20`, newest first) — better for recall. `--sort meat` ranks by writes/users/size when hunting junk. User picks keepers or `--drop-session` the noise.
5. Inside a living project, `--rollup git` groups sessions by the folder they wrote most. **dead** = that folder is gone (git delete or `_archive/*.zip`). **merged** = folded into another ext (ui-theme stubs). Do not git-drop `live` / `docs`.
6. `--bucket likely` is the small scratch leftover. Do not `--bucket review` / `--bucket keep`.
7. Short/broken inside live projects: `--highlights short` (default `--max-bytes 60000`, smallest first). Flags: `broken` (unreadable/empty), `no-reply`, `one-shot`, `no-write`, `cwd-gone`. The `bucket` column shows what the buckets already handle — unreviewed ones are `keep`. Drop individually with `--drop-session`.
8. Old per project: `--rollup stale` ranks projects by old bytes. `cwd=dead` → folder gone, strong drop. Old but `cwd=alive` → ask the user (they told us some projects just run rarely). Act per project: `--project NAME --older DAYS` (dry-run), then `--apply` to quarantine.
9. Never paste the per-session list into chat. `--list` goes to a file if needed.

`--json` without `--out` is the slim report (`meta`, `buckets`, `projects`). Use `--out` when a later step needs paths.
