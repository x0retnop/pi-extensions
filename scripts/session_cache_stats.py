#!/usr/bin/env python3
"""Analyze prompt-cache behavior from Pi session JSONL (assistant usage fields).

LLM-first: prefer ``--json``. Human text is a compact mirror of the same report.

Classifies each assistant turn relative to the previous one (mid_loop /
after_user / after_idle / …), estimates Pi-style misses, and splits by idle
age so agents can reason about TTL, affinity deploys, and /warm windows.

Examples::

    python scripts/session_cache_stats.py --since 14 --json
    python scripts/session_cache_stats.py --since 7 --provider provider-a --json
    python scripts/session_cache_stats.py --since 14 --sessions --json
    python scripts/session_cache_stats.py path/to/session.jsonl --json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

try:
    from pi_session_inspect import extract_project, get_sessions_dir, iter_sessions
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from pi_session_inspect import extract_project, get_sessions_dir, iter_sessions  # type: ignore

# Pi cache-miss notice heuristic (Anthropic default TTL), not a provider hard limit.
CACHE_TTL_MS = 5 * 60 * 1000
NOISE_FLOOR = 1024
NOTICE_FLOOR = 20_000

# a-rewind /warm defaults (must stay aligned with a-rewind/index.ts).
WARM_MIN_IDLE_MS = 3 * 60 * 1000
WARM_MAX_IDLE_MS = (4 * 60 + 45) * 1000

# Fine idle buckets for after_user (<5m) and after_idle (≥5m).
# Order matters for report tables.
AFTER_USER_IDLE_BUCKETS: list[tuple[str, int | None]] = [
    ("lt_30s", 30_000),
    ("30s_2m", 120_000),
    ("2m_3m", 180_000),
    ("3m_5m", CACHE_TTL_MS),
    ("ge_5m_misclass", None),  # should be rare; kind should be after_idle
]
AFTER_IDLE_BUCKETS: list[tuple[str, int | None]] = [
    ("5-7m", 7 * 60_000),
    ("7-10m", 10 * 60_000),
    ("10-15m", 15 * 60_000),
    ("15-30m", 30 * 60_000),
    ("30-60m", 60 * 60_000),
    (">=60m", None),
]


@dataclass
class Turn:
    order: int
    session: str
    project: str
    provider: str
    model: str
    stop: str
    ts: int
    input: int
    output: int
    cache_read: int
    cache_write: int
    prompt: int
    ch_pct: float | None
    idle_ms: int | None
    kind: str  # first | mid_loop | after_user | after_idle | after_model_switch | after_compaction
    missed_vs_prev: int | None  # Pi-style: min(prev.prompt, prompt) - cacheRead
    tool_calls: int
    # Hidden trigger that started this turn, if any (session custom entry).
    trigger: str | None  # warm | retry | None
    # Idle bucket labels (set in summarize for convenience in samples).
    idle_bucket: str | None = None


def _usage(m: dict) -> dict | None:
    u = m.get("usage")
    if not isinstance(u, dict):
        return None
    inp = int(u.get("input") or 0)
    out = int(u.get("output") or 0)
    cr = int(u.get("cacheRead") or 0)
    cw = int(u.get("cacheWrite") or 0)
    if inp + out + cr + cw <= 0:
        return None
    return {"input": inp, "output": out, "cacheRead": cr, "cacheWrite": cw}


def _prompt(u: dict) -> int:
    return u["input"] + u["cacheRead"] + u["cacheWrite"]


def _ch(u: dict) -> float | None:
    p = _prompt(u)
    if p <= 0:
        return None
    return 100.0 * u["cacheRead"] / p


def _custom_trigger(m: dict) -> str | None:
    """Map session customType → short trigger label for the next assistant turn."""
    if m.get("role") != "custom":
        return None
    ct = str(m.get("customType") or "")
    if ct in ("a-warm-trigger", "warm", "a-warm"):
        return "warm"
    if ct in ("a-retry-trigger", "retry", "a-retry"):
        return "retry"
    return None


def load_entries(path: Path) -> list[dict]:
    out = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return out


def analyze_session(path: Path) -> list[Turn]:
    entries = load_entries(path)
    project = extract_project(path)
    turns: list[Turn] = []
    prev_assistant: dict | None = None
    saw_user_since_assistant = False
    saw_compaction = False
    pending_trigger: str | None = None
    order = 0

    for ent in entries:
        et = ent.get("type")
        if et in ("compaction", "branch_summary"):
            saw_compaction = True
            prev_assistant = None
            pending_trigger = None
            continue
        if et != "message":
            continue
        m = ent.get("message") or {}
        role = m.get("role")
        ts = int(m.get("timestamp") or 0)

        if role == "custom":
            t = _custom_trigger(m)
            if t:
                pending_trigger = t
            continue

        if role == "user":
            saw_user_since_assistant = True
            continue

        if role != "assistant":
            continue

        u = _usage(m)
        if not u:
            continue

        provider = str(m.get("provider") or "?")
        model = str(m.get("model") or "?")
        stop = str(m.get("stopReason") or "?")
        content = m.get("content") or []
        n_tools = sum(
            1
            for c in content
            if isinstance(c, dict) and c.get("type") == "toolCall"
        )

        prompt = _prompt(u)
        ch = _ch(u)
        idle_ms = None
        missed = None
        kind = "first"
        trigger = pending_trigger
        pending_trigger = None

        if prev_assistant is None:
            kind = "after_compaction" if saw_compaction else "first"
            saw_compaction = False
        else:
            idle_ms = max(0, ts - prev_assistant["ts"])
            model_key = f"{provider}/{model}"
            prev_key = prev_assistant["model_key"]
            if model_key != prev_key:
                kind = "after_model_switch"
            elif idle_ms >= CACHE_TTL_MS:
                kind = "after_idle"
            elif saw_user_since_assistant:
                kind = "after_user"
            else:
                kind = "mid_loop"

            prev_prompt = prev_assistant["prompt"]
            missed = min(prev_prompt, prompt) - u["cacheRead"]
            if missed < 0:
                missed = 0

        turns.append(
            Turn(
                order=order,
                session=path.name,
                project=project,
                provider=provider,
                model=model,
                stop=stop,
                ts=ts,
                input=u["input"],
                output=u["output"],
                cache_read=u["cacheRead"],
                cache_write=u["cacheWrite"],
                prompt=prompt,
                ch_pct=ch,
                idle_ms=idle_ms,
                kind=kind,
                missed_vs_prev=missed,
                tool_calls=n_tools,
                trigger=trigger,
            )
        )
        order += 1
        prev_assistant = {
            "ts": ts,
            "prompt": prompt,
            "model_key": f"{provider}/{model}",
            "cache_activity": u["cacheRead"] + u["cacheWrite"] > 0,
        }
        saw_user_since_assistant = False
        saw_compaction = False

    return turns


def pct(n: float, d: float) -> float | None:
    if d <= 0:
        return None
    return round(100.0 * n / d, 1)


def bucket_ch(ch: float | None) -> str:
    if ch is None:
        return "n/a"
    if ch < 1:
        return "0%"
    if ch < 25:
        return "1-24%"
    if ch < 50:
        return "25-49%"
    if ch < 75:
        return "50-74%"
    if ch < 90:
        return "75-89%"
    return "90-100%"


def _idle_bucket(ms: int | None, table: list[tuple[str, int | None]]) -> str | None:
    if ms is None:
        return None
    for name, upper in table:
        if upper is None or ms < upper:
            return name
    return table[-1][0]


def kind_stats(items: list[Turn]) -> dict:
    if not items:
        return {"n": 0}
    chs = [t.ch_pct for t in items if t.ch_pct is not None]
    prompts = [t.prompt for t in items]
    reads = [t.cache_read for t in items]
    inputs = [t.input for t in items]
    misses = [t.missed_vs_prev for t in items if t.missed_vs_prev is not None]
    big_miss = [m for m in misses if m >= NOTICE_FLOOR]
    zero_ch = sum(1 for c in chs if c is not None and c < 1)
    high_ch = sum(1 for c in chs if c is not None and c >= 75)
    idle = [t.idle_ms for t in items if t.idle_ms is not None]
    buckets = Counter(bucket_ch(t.ch_pct) for t in items)
    warm_n = sum(1 for t in items if t.trigger == "warm")
    retry_n = sum(1 for t in items if t.trigger == "retry")
    return {
        "n": len(items),
        "avg_ch_pct": round(sum(chs) / len(chs), 1) if chs else None,
        "median_ch_pct": round(sorted(chs)[len(chs) // 2], 1) if chs else None,
        "p10_ch_pct": round(sorted(chs)[max(0, len(chs) // 10)], 1) if chs else None,
        "p90_ch_pct": round(sorted(chs)[min(len(chs) - 1, 9 * len(chs) // 10)], 1) if chs else None,
        "share_ch_0pct": pct(zero_ch, len(chs)),
        "share_ch_ge75pct": pct(high_ch, len(chs)),
        "ch_buckets": dict(buckets),
        "avg_prompt": int(sum(prompts) / len(prompts)) if prompts else 0,
        "avg_cache_read": int(sum(reads) / len(reads)) if reads else 0,
        "avg_input": int(sum(inputs) / len(inputs)) if inputs else 0,
        "sum_cache_read": sum(reads),
        "sum_input": sum(inputs),
        "sum_prompt": sum(prompts),
        "sum_output": sum(t.output for t in items),
        "cache_share_of_prompt_pct": pct(sum(reads), sum(prompts)),
        "avg_missed_vs_prev": int(sum(misses) / len(misses)) if misses else None,
        "sum_missed_vs_prev": sum(misses) if misses else 0,
        "turns_with_notice_sized_miss": len(big_miss),
        "sum_notice_sized_miss_tokens": sum(big_miss),
        "avg_idle_sec": round(sum(idle) / len(idle) / 1000, 1) if idle else None,
        "median_idle_sec": round(sorted(idle)[len(idle) // 2] / 1000, 1) if idle else None,
        "warm_trigger_turns": warm_n,
        "retry_trigger_turns": retry_n,
    }


def session_row(sess: str, items: list[Turn]) -> dict:
    mid = [t for t in items if t.kind == "mid_loop"]
    aft_u = [t for t in items if t.kind == "after_user"]
    aft_i = [t for t in items if t.kind == "after_idle"]
    notice = [t for t in items if (t.missed_vs_prev or 0) >= NOTICE_FLOOR]
    warm = [t for t in items if t.trigger == "warm"]
    providers = Counter(f"{t.provider}/{t.model}" for t in items)
    top_pm = providers.most_common(1)[0][0] if providers else "?/?"
    total_prompt = sum(t.prompt for t in items)
    total_cr = sum(t.cache_read for t in items)
    mid_s = kind_stats(mid)
    au_s = kind_stats(aft_u)
    ai_s = kind_stats(aft_i)
    return {
        "session": sess,
        "project": items[0].project,
        "provider_model": top_pm,
        "n": len(items),
        "overall_ch_pct": pct(total_cr, total_prompt),
        "sum_prompt": total_prompt,
        "sum_cache_read": total_cr,
        "sum_input": sum(t.input for t in items),
        "sum_missed_vs_prev": sum(t.missed_vs_prev or 0 for t in items if t.missed_vs_prev is not None),
        "notice_miss_turns": len(notice),
        "notice_miss_tokens": sum(t.missed_vs_prev or 0 for t in notice),
        "mid_loop_n": mid_s.get("n", 0),
        "mid_loop_avg_ch": mid_s.get("avg_ch_pct"),
        "mid_loop_med_ch": mid_s.get("median_ch_pct"),
        "after_user_n": au_s.get("n", 0),
        "after_user_avg_ch": au_s.get("avg_ch_pct"),
        "after_user_med_ch": au_s.get("median_ch_pct"),
        "after_user_avg_miss": au_s.get("avg_missed_vs_prev"),
        "after_idle_n": ai_s.get("n", 0),
        "after_idle_avg_ch": ai_s.get("avg_ch_pct"),
        "after_idle_med_ch": ai_s.get("median_ch_pct"),
        "after_idle_ch0_pct": ai_s.get("share_ch_0pct"),
        "warm_turns": len(warm),
        "first_ts": min((t.ts for t in items if t.ts), default=0),
        "last_ts": max((t.ts for t in items if t.ts), default=0),
    }


def filter_turns(
    turns: list[Turn],
    *,
    provider: str | None,
    model: str | None,
) -> list[Turn]:
    out = turns
    if provider:
        p = provider.lower()
        out = [t for t in out if p in t.provider.lower()]
    if model:
        m = model.lower()
        out = [t for t in out if m in t.model.lower()]
    return out


def summarize(
    turns: list[Turn],
    *,
    include_sessions: bool = True,
    top_sessions: int = 40,
) -> dict:
    by_kind: dict[str, list[Turn]] = defaultdict(list)
    by_provider: dict[str, list[Turn]] = defaultdict(list)
    by_session: dict[str, list[Turn]] = defaultdict(list)
    by_project: dict[str, list[Turn]] = defaultdict(list)

    for t in turns:
        by_kind[t.kind].append(t)
        by_provider[f"{t.provider}/{t.model}"].append(t)
        by_session[t.session].append(t)
        by_project[t.project].append(t)
        if t.kind == "after_user":
            t.idle_bucket = _idle_bucket(t.idle_ms, AFTER_USER_IDLE_BUCKETS)
        elif t.kind == "after_idle":
            t.idle_bucket = _idle_bucket(t.idle_ms, AFTER_IDLE_BUCKETS)

    after_user = by_kind.get("after_user", [])
    after_idle = by_kind.get("after_idle", [])

    au_by_idle: dict[str, list[Turn]] = {name: [] for name, _ in AFTER_USER_IDLE_BUCKETS}
    for t in after_user:
        b = t.idle_bucket or "ge_5m_misclass"
        au_by_idle.setdefault(b, []).append(t)

    ai_by_idle: dict[str, list[Turn]] = {name: [] for name, _ in AFTER_IDLE_BUCKETS}
    for t in after_idle:
        b = t.idle_bucket or ">=60m"
        ai_by_idle.setdefault(b, []).append(t)

    # Warm window: idle in [3m, 4m45s] — a-rewind /warm acceptance band.
    # Includes after_user (idle <5m) and after_idle that fall in range (none if max <5m).
    warm_window = [
        t
        for t in turns
        if t.idle_ms is not None and WARM_MIN_IDLE_MS <= t.idle_ms <= WARM_MAX_IDLE_MS
    ]
    warm_trigger_turns = [t for t in turns if t.trigger == "warm"]

    # Contrast: good mid_loop, weak after_user
    contrast = []
    for sess, items in by_session.items():
        mid = [t for t in items if t.kind == "mid_loop" and t.ch_pct is not None]
        aft = [t for t in items if t.kind == "after_user" and t.ch_pct is not None]
        if len(mid) < 3 or len(aft) < 1:
            continue
        mid_avg = sum(t.ch_pct for t in mid) / len(mid)
        aft_avg = sum(t.ch_pct for t in aft) / len(aft)
        if mid_avg >= 70 and aft_avg <= 30:
            contrast.append(
                {
                    "session": sess,
                    "project": items[0].project,
                    "provider": items[0].provider,
                    "model": items[0].model,
                    "mid_loop_n": len(mid),
                    "mid_loop_avg_ch": round(mid_avg, 1),
                    "after_user_n": len(aft),
                    "after_user_avg_ch": round(aft_avg, 1),
                    "after_user_avg_idle_sec": round(
                        sum(t.idle_ms or 0 for t in aft) / len(aft) / 1000, 1
                    ),
                    "after_user_avg_missed": int(
                        sum(t.missed_vs_prev or 0 for t in aft) / len(aft)
                    ),
                }
            )
    contrast.sort(key=lambda x: x["mid_loop_avg_ch"] - x["after_user_avg_ch"], reverse=True)

    prov_report = {}
    for key, items in by_provider.items():
        any_cache = sum(1 for t in items if t.cache_read + t.cache_write > 0)
        mid = [t for t in items if t.kind == "mid_loop"]
        au = [t for t in items if t.kind == "after_user"]
        ai = [t for t in items if t.kind == "after_idle"]
        prov_report[key] = {
            "n": len(items),
            "turns_with_any_cache": any_cache,
            "share_with_cache_pct": pct(any_cache, len(items)),
            "mid_loop": kind_stats(mid),
            "after_user": kind_stats(au),
            "after_idle": kind_stats(ai),
            **kind_stats(items),
        }

    total_prompt = sum(t.prompt for t in turns)
    total_cr = sum(t.cache_read for t in turns)
    total_in = sum(t.input for t in turns)
    notice_misses = [
        t
        for t in turns
        if t.missed_vs_prev is not None and t.missed_vs_prev >= NOTICE_FLOOR
    ]

    sessions = [session_row(s, items) for s, items in by_session.items()]
    sessions.sort(key=lambda r: -(r.get("notice_miss_tokens") or 0))

    projects = []
    for proj, items in by_project.items():
        projects.append(
            {
                "project": proj,
                **kind_stats(items),
                "sessions": len({t.session for t in items}),
            }
        )
    projects.sort(key=lambda r: -r.get("n", 0))

    mid = kind_stats(by_kind.get("mid_loop", []))
    aft_u = kind_stats(by_kind.get("after_user", []))
    aft_i = kind_stats(by_kind.get("after_idle", []))
    ww = kind_stats(warm_window)
    wt = kind_stats(warm_trigger_turns)

    insights: list[str] = []
    if mid.get("n") and aft_u.get("n"):
        insights.append(
            f"mid_loop avg CH {mid.get('avg_ch_pct')}% (n={mid['n']}) vs "
            f"after_user avg CH {aft_u.get('avg_ch_pct')}% (n={aft_u['n']})."
        )
    if mid.get("share_ch_ge75pct") is not None:
        insights.append(
            f"mid_loop: {mid['share_ch_ge75pct']}% of turns have CH≥75%; "
            f"{mid['share_ch_0pct']}% have CH≈0%."
        )
    if aft_u.get("share_ch_0pct") is not None:
        insights.append(
            f"after_user: {aft_u['share_ch_0pct']}% CH≈0%; "
            f"{aft_u['share_ch_ge75pct']}% CH≥75%; "
            f"median idle {aft_u.get('median_idle_sec')}s."
        )
    if aft_i.get("n"):
        insights.append(
            f"after_idle (≥5m): n={aft_i['n']}, avg CH {aft_i.get('avg_ch_pct')}%, "
            f"med CH {aft_i.get('median_ch_pct')}%, CH≈0 share {aft_i.get('share_ch_0pct')}%."
        )
        # Highlight soft TTL: 5-10m still often hot, 30m+ usually dead.
        for bname in ("5-7m", "7-10m", "15-30m", "30-60m"):
            s = kind_stats(ai_by_idle.get(bname, []))
            if s.get("n"):
                insights.append(
                    f"after_idle {bname}: n={s['n']} medCH={s.get('median_ch_pct')}% "
                    f"CH0={s.get('share_ch_0pct')}% CH≥75={s.get('share_ch_ge75pct')}%."
                )
    if ww.get("n"):
        insights.append(
            f"warm-window idle (3m–4m45s): n={ww['n']} avgCH={ww.get('avg_ch_pct')}% "
            f"medCH={ww.get('median_ch_pct')}% — band where /warm is allowed."
        )
    if wt.get("n"):
        insights.append(
            f"/warm trigger turns: n={wt['n']} avgCH={wt.get('avg_ch_pct')}% "
            f"avgOut={wt.get('sum_output', 0) // max(wt['n'], 1)} "
            f"avgMiss={wt.get('avg_missed_vs_prev')}."
        )
    if total_prompt:
        insights.append(
            f"Across all turns: cacheRead={total_cr:,} / prompt={total_prompt:,} "
            f"({pct(total_cr, total_prompt)}%); paid input bucket={total_in:,}."
        )
    insights.append(
        f"Pi-style notice-sized misses (≥{NOTICE_FLOOR} tok vs prev): "
        f"{len(notice_misses)} turns, sum {sum(t.missed_vs_prev or 0 for t in notice_misses):,} tok."
    )
    if contrast:
        insights.append(
            f"{len(contrast)} sessions have strong contrast "
            f"(mid_loop CH≥70% but after_user CH≤30%)."
        )

    report: dict = {
        "meta": {
            "command": "cache-stats",
            "cache_ttl_ms": CACHE_TTL_MS,
            "warm_min_idle_ms": WARM_MIN_IDLE_MS,
            "warm_max_idle_ms": WARM_MAX_IDLE_MS,
            "noise_floor": NOISE_FLOOR,
            "notice_floor_tokens": NOTICE_FLOOR,
            "kind_defs": {
                "mid_loop": "assistant→assistant, no user between, idle <5m, same model",
                "after_user": "user message since last assistant, idle <5m, same model",
                "after_idle": "gap ≥5m between assistant turns (Pi CACHE_TTL heuristic)",
                "after_model_switch": "provider/model changed",
                "first": "first assistant with usage in session (or after compaction reset)",
                "after_compaction": "first assistant after compaction/branch_summary",
            },
            "idle_bucket_defs": {
                "after_user": {
                    name: (
                        f"idle < {upper // 1000}s"
                        if upper is not None
                        else "idle ≥5m (misclassified as after_user)"
                    )
                    for name, upper in AFTER_USER_IDLE_BUCKETS
                },
                "after_idle": {
                    name: (
                        f"idle < {upper // 60000}m"
                        if upper is not None
                        else "idle ≥60m"
                    )
                    for name, upper in AFTER_IDLE_BUCKETS
                },
            },
            "trigger_defs": {
                "warm": "session customType a-warm-trigger immediately before this assistant",
                "retry": "session customType a-retry-trigger immediately before this assistant",
            },
            "field_notes": {
                "ch_pct": "100 * cacheRead / (input+cacheRead+cacheWrite)",
                "missed_vs_prev": "max(0, min(prev.prompt, prompt) - cacheRead); Pi-style re-bill estimate",
                "overall_ch_pct": "sum cacheRead / sum prompt across turns",
                "affinity": "not observable in JSONL; A/B by date window or provider filter only",
            },
            "sessions_dir": str(get_sessions_dir()),
        },
        "totals": {
            "assistant_turns": len(turns),
            "sessions": len(by_session),
            "projects": len(by_project),
            "sum_prompt_tokens": total_prompt,
            "sum_cache_read": total_cr,
            "sum_input": total_in,
            "sum_output": sum(t.output for t in turns),
            "overall_ch_pct": pct(total_cr, total_prompt),
            "notice_sized_miss_turns": len(notice_misses),
            "notice_sized_miss_tokens": sum(t.missed_vs_prev or 0 for t in notice_misses),
            "warm_trigger_turns": len(warm_trigger_turns),
            "warm_window_turns": len(warm_window),
        },
        "by_kind": {k: kind_stats(v) for k, v in sorted(by_kind.items())},
        "after_user_by_idle": {
            k: kind_stats(au_by_idle.get(k, [])) for k, _ in AFTER_USER_IDLE_BUCKETS
        },
        "after_idle_by_idle": {
            k: kind_stats(ai_by_idle.get(k, [])) for k, _ in AFTER_IDLE_BUCKETS
        },
        # Backward-compatible coarse hist (counts only).
        "after_idle_histogram": {
            k: kind_stats(ai_by_idle.get(k, [])).get("n", 0) for k, _ in AFTER_IDLE_BUCKETS
        },
        "warm_window": {
            "idle_ms_range": [WARM_MIN_IDLE_MS, WARM_MAX_IDLE_MS],
            "idle_label": "3m–4m45s",
            "stats": ww,
        },
        "warm_trigger": {
            "stats": wt,
            "sample": [asdict(t) for t in warm_trigger_turns[:20]],
        },
        "by_provider_model": {
            k: v
            for k, v in sorted(prov_report.items(), key=lambda kv: -kv[1]["n"])[:25]
        },
        "by_project": projects[:30],
        "contrast_sessions": contrast[:25],
        "insights": insights,
        "sample_worst_after_user": [
            asdict(t)
            for t in sorted(
                [x for x in after_user if (x.missed_vs_prev or 0) >= NOTICE_FLOOR],
                key=lambda x: -(x.missed_vs_prev or 0),
            )[:15]
        ],
        "sample_worst_after_idle": [
            asdict(t)
            for t in sorted(
                [x for x in after_idle if (x.missed_vs_prev or 0) >= NOTICE_FLOOR],
                key=lambda x: -(x.missed_vs_prev or 0),
            )[:12]
        ],
        "sample_best_mid_loop": [
            asdict(t)
            for t in sorted(
                [x for x in by_kind.get("mid_loop", []) if (x.ch_pct or 0) >= 90],
                key=lambda x: -x.prompt,
            )[:8]
        ],
    }

    if include_sessions:
        report["sessions"] = sessions[:top_sessions]
        report["sessions_truncated"] = max(0, len(sessions) - top_sessions)
        report["sessions_sort"] = "notice_miss_tokens desc"

    return report


def _print_kind_line(label: str, s: dict) -> None:
    if not s.get("n"):
        return
    print(
        f"  {label:20} n={s['n']:5}  "
        f"avgCH={s.get('avg_ch_pct')}%  medCH={s.get('median_ch_pct')}%  "
        f"CH0%={s.get('share_ch_0pct')}%  CH≥75%={s.get('share_ch_ge75pct')}%  "
        f"avgPrompt={s.get('avg_prompt'):,}  "
        f"avgMiss={s.get('avg_missed_vs_prev')}  "
        f"noticeMiss={s.get('turns_with_notice_sized_miss')}"
    )
    if s.get("ch_buckets"):
        print(f"    buckets: {s['ch_buckets']}")


def print_report(r: dict, *, show_sessions: bool) -> None:
    t = r["totals"]
    print("=== session cache stats (from assistant usage) ===")
    print(f"Turns: {t['assistant_turns']}  Sessions: {t['sessions']}  Projects: {t['projects']}")
    print(
        f"Prompt tokens: {t['sum_prompt_tokens']:,}  "
        f"cacheRead: {t['sum_cache_read']:,} ({t['overall_ch_pct']}%)  "
        f"input: {t['sum_input']:,}  output: {t['sum_output']:,}"
    )
    print(
        f"Notice-sized misses (≥{r['meta']['notice_floor_tokens']} tok): "
        f"{t['notice_sized_miss_turns']} turns / {t['notice_sized_miss_tokens']:,} tok"
    )
    if t.get("warm_trigger_turns"):
        print(f"Warm trigger turns: {t['warm_trigger_turns']}")
    print()
    print("By turn kind:")
    for kind, s in r["by_kind"].items():
        _print_kind_line(kind, s)
    print()
    print("after_user by idle (<5m):")
    for k, s in r["after_user_by_idle"].items():
        if not s.get("n"):
            continue
        print(
            f"  {k:12} n={s['n']:4}  avgCH={s.get('avg_ch_pct')}%  "
            f"medCH={s.get('median_ch_pct')}%  CH0%={s.get('share_ch_0pct')}%  "
            f"avgMiss={s.get('avg_missed_vs_prev')}  medIdle={s.get('median_idle_sec')}s"
        )
    print()
    print("after_idle by idle (≥5m, fine buckets):")
    for k, s in r["after_idle_by_idle"].items():
        if not s.get("n"):
            continue
        print(
            f"  {k:12} n={s['n']:4}  avgCH={s.get('avg_ch_pct')}%  "
            f"medCH={s.get('median_ch_pct')}%  CH0%={s.get('share_ch_0pct')}%  "
            f"CH≥75%={s.get('share_ch_ge75pct')}%  avgMiss={s.get('avg_missed_vs_prev')}"
        )
    ww = r.get("warm_window", {}).get("stats") or {}
    if ww.get("n"):
        print()
        print(
            f"warm window (3m–4m45s): n={ww['n']} avgCH={ww.get('avg_ch_pct')}% "
            f"medCH={ww.get('median_ch_pct')}% CH0={ww.get('share_ch_0pct')}%"
        )
    print()
    print("Top provider/model by turns:")
    for key, s in list(r["by_provider_model"].items())[:8]:
        print(
            f"  {key}: n={s['n']}  anyCache={s['share_with_cache_pct']}%  "
            f"avgCH={s.get('avg_ch_pct')}%  CH0%={s.get('share_ch_0pct')}%  "
            f"mid={s.get('mid_loop', {}).get('avg_ch_pct')}%  "
            f"after_user={s.get('after_user', {}).get('avg_ch_pct')}%  "
            f"after_idle={s.get('after_idle', {}).get('avg_ch_pct')}%"
        )
    print()
    print("Insights:")
    for line in r["insights"]:
        print(f"  - {line}")
    if r["contrast_sessions"]:
        print()
        print("Contrast sessions (good mid_loop, weak after_user):")
        for c in r["contrast_sessions"][:10]:
            print(
                f"  [{c['project']}] mid {c['mid_loop_avg_ch']}% (n={c['mid_loop_n']}) → "
                f"after_user {c['after_user_avg_ch']}% (n={c['after_user_n']}, "
                f"idle~{c['after_user_avg_idle_sec']}s, miss~{c['after_user_avg_missed']})  "
                f"{c['provider']}/{c['model']}"
            )
            print(f"    {c['session']}")
    if show_sessions and r.get("sessions"):
        print()
        print(f"Sessions (top {len(r['sessions'])} by notice_miss_tokens):")
        for s in r["sessions"][:15]:
            print(
                f"  [{s['project']}] n={s['n']} CH={s['overall_ch_pct']}% "
                f"mid={s['mid_loop_avg_ch']}% au={s['after_user_avg_ch']}% "
                f"ai={s['after_idle_avg_ch']}% "
                f"noticeMiss={s['notice_miss_tokens']:,} tok "
                f"warm={s['warm_turns']}  {s['provider_model']}"
            )
            print(f"    {s['session']}")
    if r["sample_worst_after_user"]:
        print()
        print("Worst after_user misses (sample):")
        for t in r["sample_worst_after_user"][:8]:
            print(
                f"  miss={t['missed_vs_prev']:,} CH={t['ch_pct']}% "
                f"prompt={t['prompt']:,} idle={round((t['idle_ms'] or 0)/1000)}s "
                f"bucket={t.get('idle_bucket')} "
                f"[{t['project']}] {t['provider']}/{t['model']}"
            )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Analyze prompt cache from session usage (LLM-first: use --json)"
    )
    p.add_argument("session", nargs="?", help="Optional single .jsonl")
    p.add_argument("--since", type=int, metavar="DAYS")
    p.add_argument("--recent", type=int, metavar="N")
    p.add_argument("--project", metavar="NAME")
    p.add_argument(
        "--provider",
        metavar="SUBSTR",
        help="Substring filter on message.provider (e.g. provider-a)",
    )
    p.add_argument(
        "--model",
        metavar="SUBSTR",
        help="Substring filter on message.model (e.g. model-a, model-b-mini)",
    )
    p.add_argument("--json", action="store_true", help="Full structured report for agents")
    p.add_argument(
        "--sessions",
        action="store_true",
        help="Include per-session rows in human output (always in --json)",
    )
    p.add_argument(
        "--top-sessions",
        type=int,
        default=40,
        metavar="N",
        help="Max per-session rows in JSON (default 40; 0 = all)",
    )
    p.add_argument(
        "--min-turns",
        type=int,
        default=1,
        help="Skip sessions with fewer assistant turns than this",
    )
    args = p.parse_args(argv)

    paths = [Path(args.session)] if args.session else None
    if paths and not paths[0].exists():
        print(f"not found: {paths[0]}", file=sys.stderr)
        return 1

    all_turns: list[Turn] = []
    for path in iter_sessions(
        recent=args.recent, since_days=args.since, project=args.project, paths=paths
    ):
        turns = analyze_session(path)
        if len(turns) < args.min_turns:
            continue
        all_turns.extend(turns)

    all_turns = filter_turns(all_turns, provider=args.provider, model=args.model)

    top = args.top_sessions
    if top <= 0:
        top = 10_000

    report = summarize(
        all_turns,
        include_sessions=True,
        top_sessions=top,
    )
    report["meta"]["filters"] = {
        "since_days": args.since,
        "recent": args.recent,
        "project": args.project,
        "provider": args.provider,
        "model": args.model,
        "min_turns": args.min_turns,
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_report(report, show_sessions=args.sessions)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
