#!/usr/bin/env python3
"""Subscription-aware usage statistics over Pi session logs.

Reads ~/.pi/agent/sessions/*/*.jsonl in one streaming pass and writes a JSON + Markdown
report (see docs/scripts/session_usage_stats.md). Nominal cost is the provider's API-list
price recorded in each assistant message (`usage.cost.total`); "paid" is the subscription
fee prorated to the window. Never writes into ~/.pi/agent.

    python scripts/session_usage_stats.py                      # last 7 days
    python scripts/session_usage_stats.py --week last
    python scripts/session_usage_stats.py --month 2026-09
    python scripts/session_usage_stats.py --from 2026-09-01 --to 2026-09-30 --days 30
    python scripts/session_usage_stats.py --week this --out reports/session-usage --no-write
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import glob
import json
import os
import statistics
import sys
import time

SCHEMA = 3
SCRIPT = "session_usage_stats.py"
ROOT = os.path.expanduser("~/.pi/agent/sessions")
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "reports", "session-usage")

# Two registries live in a private config file next to this script, never in the script
# itself: `plans` (the subscriptions actually paid for) and `categories` (which project
# folder is which kind of work). Keeping the data out of the code is what makes the script
# publishable — a fresh clone with no config still runs on neutral example rows.
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "session-usage.config.json")

DEFAULT_PLANS = [
    {"id": "plan-a", "label": "Subscription A", "fee": 20.0, "providers": ["provider-a"]},
    {"id": "local", "label": "Local", "fee": 0.0, "providers": ["infer"]},
]
DEFAULT_CATEGORIES = {
    "apps": ["example-app"],
    "experiments": ["scratch", "tests"],
}
DEFAULT_OVERRIDES = {}


def load_config(path: str = CONFIG_PATH) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}


CONFIG = load_config()
PLANS = CONFIG.get("plans", DEFAULT_PLANS)
MODEL_PLAN_OVERRIDE = CONFIG.get("modelPlanOverrides", DEFAULT_OVERRIDES)
CATEGORIES = CONFIG.get("categories", DEFAULT_CATEGORIES)
PROJECT_CATEGORY = {p: c for c, ps in CATEGORIES.items() for p in ps}
PROVIDER_PLAN = {p: pl["id"] for pl in PLANS for p in pl["providers"]}
PLAN_BY_ID = {pl["id"]: pl for pl in PLANS}
DAYS_PER_MONTH = 30.4375
PAUSE_SEC = 30 * 60


# ---------------------------------------------------------------- period

def iso_week(d: dt.date) -> tuple[int, int]:
    y, w, _ = d.isocalendar()
    return y, w


def week_range(spec: str) -> tuple[dt.datetime, dt.datetime, str]:
    today = dt.date.today()
    if spec in ("this", "last"):
        monday = today - dt.timedelta(days=today.weekday())
        if spec == "last":
            monday -= dt.timedelta(days=7)
        start = monday
    elif "W" in spec.upper():
        y, w = spec.upper().split("-W")
        start = dt.date.fromisocalendar(int(y), int(w), 1)
    else:
        start = dt.date.fromisoformat(spec)
        start -= dt.timedelta(days=start.weekday())
    end = start + dt.timedelta(days=6)
    y, w = iso_week(start)
    return _span(start, end, f"week {y}-W{w:02d}")


def month_range(spec: str) -> tuple[dt.datetime, dt.datetime, str]:
    today = dt.date.today()
    if spec in ("this", "last"):
        y, m = today.year, today.month
        if spec == "last":
            m -= 1
            if m == 0:
                y, m = y - 1, 12
    else:
        y, m = (int(x) for x in spec.split("-"))
    start = dt.date(y, m, 1)
    nxt = dt.date(y + (m == 12), 1 if m == 12 else m + 1, 1)
    return _span(start, nxt - dt.timedelta(days=1), f"month {y}-{m:02d}")


def _span(start: dt.date, end: dt.date, label: str):
    today = dt.date.today()
    if end > today:
        end = today
        label += " (partial)"
    lo = dt.datetime.combine(start, dt.time.min)
    hi = dt.datetime.combine(end, dt.time.max)
    return lo, hi, label


def resolve_period(a) -> tuple[dt.datetime, dt.datetime, str]:
    if a.week:
        return week_range(a.week)
    if a.month:
        return month_range(a.month)
    if a.frm or a.to:
        start = dt.date.fromisoformat(a.frm) if a.frm else dt.date.fromisoformat(a.to)
        end = dt.date.fromisoformat(a.to) if a.to else dt.date.today()
        return _span(start, end, f"{start}..{end}")
    today = dt.date.today()
    start = today - dt.timedelta(days=a.days - 1)
    return _span(start, today, f"last {a.days} days")


# ---------------------------------------------------------------- scan

def buckets():
    return collections.defaultdict(collections.Counter)


def new_bucket():
    return collections.Counter()


def add_usage(b: collections.Counter, usage: dict):
    cost = (usage.get("cost") or {}).get("total", 0) or 0
    b["nominal"] += cost
    b["calls"] += 1
    for src, dst in (("input", "in"), ("output", "out"), ("cacheRead", "cread"),
                     ("cacheWrite", "cwrite"), ("reasoning", "reason")):
        b[dst] += usage.get(src, 0) or 0
    return cost


def scan(lo: dt.datetime, hi: dt.datetime, project_filter: str | None):
    lo_ms, hi_ms = lo.timestamp() * 1000, hi.timestamp() * 1000
    files = []
    for p in glob.glob(os.path.join(ROOT, "*", "*.jsonl")):
        if os.path.getmtime(p) * 1000 >= lo_ms:
            if project_filter and project_filter not in p:
                continue
            files.append(p)
    files.sort()

    by_day, by_week, by_project, by_model, by_tool = (buckets() for _ in range(5))
    by_cat_model = buckets()   # (category, model) -> usage; the activity x model cross
    by_plan = buckets()
    plan_day = collections.defaultdict(collections.Counter)   # day -> plan -> nominal
    sessions = {}
    turn_secs, tool_secs = [], collections.Counter()
    unmapped = collections.Counter()
    scanned_bytes = 0
    t0 = time.time()

    for path in files:
        scanned_bytes += os.path.getsize(path)
        folder = os.path.basename(os.path.dirname(path))
        s = {"file": os.path.join(folder, os.path.basename(path)), "folder": folder,
             "cwd": None, "nameStart": None, "resumedHours": None,
             "first": None, "last": None, "active": 0.0, "turns": 0, "users": 0,
             "assistant": 0, "tools": 0, "toolErrors": 0, "pauses": 0, "idle": 0.0,
             "nominal": 0.0, "plans": collections.Counter(), "models": collections.Counter(),
             "ts": []}
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if '"type":"message"' in line:
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    m = rec["message"]
                    ts = m.get("timestamp")
                    if not isinstance(ts, (int, float)) or not (lo_ms <= ts <= hi_ms):
                        continue
                    when = dt.datetime.fromtimestamp(ts / 1000)
                    dk = when.strftime("%Y-%m-%d")
                    wk = (when - dt.timedelta(days=when.weekday())).strftime("%Y-%m-%d")
                    role = m.get("role")
                    s["first"] = s["first"] or when
                    s["last"] = when
                    s["ts"].append(ts)
                    for b in (by_day[dk], by_week[wk], by_project[_project(s, folder)]):
                        b["msgs"] += 1
                    if role == "user":
                        s["users"] += 1
                        by_day[dk]["user"] += 1
                        by_week[wk]["user"] += 1
                        by_project[_project(s, folder)]["user"] += 1
                    elif role == "assistant":
                        usage = m.get("usage") or {}
                        provider, model = m.get("provider"), m.get("model")
                        plan_id = MODEL_PLAN_OVERRIDE.get(model) or PROVIDER_PLAN.get(provider)
                        if plan_id is None:
                            unmapped[provider] += 1
                            plan_id = "unmapped"
                        cost = add_usage(by_plan[plan_id], usage)
                        s["nominal"] += cost
                        s["plans"][plan_id] += cost
                        s["models"][model] += 1
                        s["assistant"] += 1
                        plan_day[dk][plan_id] += cost
                        for b in (by_day[dk], by_week[wk],
                                  by_project[_project(s, folder)]):
                            add_usage(b, usage)
                        add_usage(by_model[(provider, model)], usage)
                        add_usage(by_cat_model[(_category(_project(s, folder)), model)], usage)
                        for block in m.get("content") or []:
                            if block.get("type") == "toolCall":
                                s["tools"] += 1
                                by_tool[block.get("name")]["calls"] += 1
                                for b in (by_day[dk], by_week[wk],
                                          by_project[_project(s, folder)]):
                                    b["toolCalls"] += 1
                    elif role == "toolResult":
                        # tool invocations are counted from the assistant toolCall blocks;
                        # here only the outcome, so calls are never double counted.
                        err = bool(m.get("isError"))
                        s["toolErrors"] += err
                        by_tool[m.get("toolName")]["errors"] += err
                        if err:
                            for b in (by_day[dk], by_week[wk],
                                      by_project[_project(s, folder)]):
                                b["toolErrors"] += 1
                elif '"ui-turn"' in line:
                    try:
                        data = json.loads(line)["data"]
                    except Exception:
                        continue
                    st, en = data.get("startMs"), data.get("endMs")
                    if not (st and en and en > st) or not (lo_ms <= st <= hi_ms):
                        continue
                    when = dt.datetime.fromtimestamp(st / 1000)
                    dk = when.strftime("%Y-%m-%d")
                    wk = (when - dt.timedelta(days=when.weekday())).strftime("%Y-%m-%d")
                    sec = (en - st) / 1000
                    pj = _project(s, folder)
                    s["active"] += sec
                    s["turns"] += 1
                    turn_secs.append(sec)
                    for tl in data.get("tools") or []:
                        tool_secs[tl.get("tool")] += (tl.get("durMs") or 0) / 1000
                    b = by_day[dk]
                    b["active"] += sec
                    b["turns"] += 1
                    by_week[wk]["active"] += sec
                    by_week[wk]["turns"] += 1
                    by_project[pj]["active"] += sec
                    by_project[pj]["turns"] += 1
                elif '"type":"session"' in line and s["cwd"] is None:
                    try:
                        hdr = json.loads(line)
                    except Exception:
                        continue
                    s["cwd"] = hdr.get("cwd")
                    name = os.path.basename(path)
                    try:
                        s["nameStart"] = dt.datetime.strptime(name[:19], "%Y-%m-%dT%H-%M-%S")
                        s["resumedHours"] = (dt.datetime.fromtimestamp(os.path.getmtime(path))
                                             - s["nameStart"]).total_seconds() / 3600
                    except Exception:
                        pass
        if not s["ts"]:
            continue
        ts = sorted(s["ts"])
        for x, y in zip(ts, ts[1:]):
            if (y - x) / 1000 > PAUSE_SEC:
                s["pauses"] += 1
                s["idle"] += (y - x) / 1000
        s["span"] = (ts[-1] - ts[0]) / 1000
        s["plans"] = {k: round(v, 4) for k, v in s["plans"].items()}
        s["models"] = dict(s["models"])
        s["project"] = _project(s, folder)
        s.pop("ts")
        sessions[path] = s

    return {
        "files": files, "sessions": sessions, "by_day": by_day, "by_week": by_week,
        "by_project": by_project, "by_model": by_model, "by_tool": by_tool,
        "by_plan": by_plan, "plan_day": plan_day, "turn_secs": turn_secs,
        "by_cat_model": by_cat_model,
        "tool_secs": tool_secs, "unmapped": unmapped, "bytes": scanned_bytes,
        "seconds": time.time() - t0,
    }


def _project(s, folder):
    if s.get("cwd"):
        return os.path.basename(s["cwd"].rstrip("\\/")) or folder
    return folder.strip("-").replace("--C--", "")


def _category(project: str) -> str:
    return PROJECT_CATEGORY.get(project, "unmapped")


# ---------------------------------------------------------------- report

def plan_rows(by_plan, days):
    rows = []
    paid_total = 0.0
    nominal_total = sum(c["nominal"] for c in by_plan.values())
    for pl in PLANS:
        c = by_plan.get(pl["id"], collections.Counter())
        paid = pl["fee"] * days / DAYS_PER_MONTH
        paid_total += paid
        rows.append({
            "id": pl["id"], "label": pl["label"], "feePerMonth": pl["fee"],
            "providers": pl["providers"], "calls": int(c["calls"]),
            "nominalUSD": round(c["nominal"], 2), "paidUSD": round(paid, 2),
            "valueX": round(c["nominal"] / paid, 2) if paid else None,
            "shareOfNominalPct": round(100 * c["nominal"] / nominal_total, 1) if nominal_total else 0,
            "tokens": {k: int(c[k]) for k in ("in", "out", "cread", "cwrite", "reason")},
        })
    for key, c in by_plan.items():
        if key in PLAN_BY_ID:
            continue
        rows.append({"id": key, "label": key, "feePerMonth": None, "providers": [],
                     "calls": int(c["calls"]), "nominalUSD": round(c["nominal"], 2),
                     "paidUSD": None, "valueX": None, "shareOfNominalPct": None,
                     "tokens": {k: int(c[k]) for k in ("in", "out", "cread", "cwrite", "reason")}})
    return rows, round(nominal_total, 2), round(paid_total, 2)


def build_report(a, lo, hi, label, data):
    days = max((hi.date() - lo.date()).days + 1, 1)
    plans, nominal_total, paid_total = plan_rows(data["by_plan"], days)
    turn_secs = sorted(data["turn_secs"])

    def pct(p):
        if not turn_secs:
            return None
        return round(turn_secs[min(int(len(turn_secs) * p), len(turn_secs) - 1)], 1)

    totals = collections.Counter()
    for c in data["by_day"].values():
        totals.update(c)
    known_active = sum(1 for s in data["sessions"].values() if s["turns"])
    by_cat = collections.defaultdict(collections.Counter)
    for name, c in data["by_project"].items():
        by_cat[_category(name)].update(c)
    cat_sessions = collections.Counter(_category(s["project"]) for s in data["sessions"].values())

    report = {
        "meta": {
            "script": SCRIPT, "schema": SCHEMA,
            "collectedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "period": {"label": label, "from": lo.date().isoformat(), "to": hi.date().isoformat(),
                       "days": days, "partial": "(partial)" in label},
            "scan": {"sessionFiles": len(data["files"]), "bytes": data["bytes"],
                     "megabytes": round(data["bytes"] / 1048576, 1),
                     "parseSeconds": round(data["seconds"], 1),
                     "sessionsWithActivity": len(data["sessions"])},
            "plansConfigured": [{"id": p["id"], "label": p["label"], "feePerMonth": p["fee"],
                                 "providers": p["providers"]} for p in PLANS],
            "modelPlanOverrides": MODEL_PLAN_OVERRIDE,
            "costModel": ("nominal = provider API-list price from usage.cost.total in the logs; "
                          "paid = subscription fee prorated over the period. Subscriptions are "
                          "flat-rate, so exceedance shows up as a quota bar, not as a bill."),
        },
        "plans": plans,
        "totals": {
            "nominalUSD": nominal_total, "paidUSD": paid_total,
            "valueX": round(nominal_total / paid_total, 2) if paid_total else None,
            "nominalPerActiveHour": (round(nominal_total / (totals["active"] / 3600), 2)
                                     if totals.get("active") else None),
            "sessions": len(data["sessions"]), "projectCount": len(data["by_project"]),
            "userMsgs": int(totals["user"]),
            "assistantMsgs": int(totals["calls"]),
            "toolCalls": int(totals["toolCalls"]),
            "toolErrors": int(totals["toolErrors"]),
            "turns": int(totals["turns"]),
            "activeHours": round(totals["active"] / 3600, 1),
            "activeCoverageSessions": f"{known_active}/{len(data['sessions'])}",
            "tokens": {k: int(totals[k]) for k in ("in", "out", "cread", "cwrite", "reason")},
        },
        "latency": {"turnP50Sec": pct(0.5), "turnP90Sec": pct(0.9), "turnP99Sec": pct(0.99)},
        "byDay": [{"date": d, "messages": int(c["msgs"]), "userMsgs": int(c["user"]),
                   "assistantMsgs": int(c["calls"]),
                   "toolCalls": int(c["toolCalls"]), "toolErrors": int(c["toolErrors"]),
                   "turns": int(c["turns"]), "activeHours": round(c["active"] / 3600, 2),
                   "nominalUSD": round(c["nominal"], 2),
                   "tokens": {k: int(c[k]) for k in ("in", "out", "cread", "reason")},
                   "plansUSD": {k: round(v, 2) for k, v in data["plan_day"][d].items()}}
                  for d, c in sorted(data["by_day"].items())],
        "byWeek": [{"weekStart": w, "nominalUSD": round(c["nominal"], 2), "turns": int(c["turns"]),
                    "activeHours": round(c["active"] / 3600, 1)}
                   for w, c in sorted(data["by_week"].items())],
        "byProject": [{"project": name, "sessions": sum(1 for s in data["sessions"].values()
                                                        if s["project"] == name),
                       "messages": int(c["msgs"]), "userMsgs": int(c["user"]),
                       "assistantMsgs": int(c["calls"]),
                       "toolCalls": int(c["toolCalls"]), "toolErrors": int(c["toolErrors"]),
                       "turns": int(c["turns"]), "activeHours": round(c["active"] / 3600, 1),
                       "nominalUSD": round(c["nominal"], 2),
                       "tokens": {k: int(c[k]) for k in ("in", "out", "cread", "reason")}}
                      for name, c in sorted(data["by_project"].items(),
                                            key=lambda kv: -kv[1]["nominal"])],
        "byCategory": [{"category": c, "projects": sorted(n for n in data["by_project"]
                                                            if _category(n) == c),
                        "projectsCount": sum(1 for n in data["by_project"] if _category(n) == c),
                        "sessions": cat_sessions[c], "messages": int(c_["msgs"]),
                        "userMsgs": int(c_["user"]),
                        "toolCalls": int(c_["toolCalls"]), "toolErrors": int(c_["toolErrors"]),
                        "turns": int(c_["turns"]), "activeHours": round(c_["active"] / 3600, 1),
                        "nominalUSD": round(c_["nominal"], 2),
                        "tokens": {k: int(c_[k]) for k in ("in", "out", "cread", "reason")}}
                       for c, c_ in sorted(by_cat.items(), key=lambda kv: -kv[1]["nominal"])],
        "byCategoryModel": [{"category": cat, "model": model, "calls": int(c["calls"]),
                             "nominalUSD": round(c["nominal"], 2),
                             "shareOfCategoryCallsPct": (round(100 * c["calls"] / by_cat[cat]["calls"], 1)
                                                         if by_cat[cat]["calls"] else None),
                             "tokens": {k: int(c[k]) for k in ("in", "out", "cread", "reason")}}
                            for (cat, model), c in sorted(
                                data["by_cat_model"].items(),
                                key=lambda kv: (-by_cat[kv[0][0]]["nominal"], -kv[1]["nominal"]))],
        "byModel": [{"provider": prov, "model": model, "calls": int(c["calls"]),
                     "nominalUSD": round(c["nominal"], 2),
                     "tokens": {k: int(c[k]) for k in ("in", "out", "cread", "reason")}}
                    for (prov, model), c in sorted(data["by_model"].items(),
                                                   key=lambda kv: -kv[1]["nominal"])],
        "byTool": [{"tool": name, "calls": int(c["calls"]), "errors": int(c["errors"]),
                    "errorRatePct": round(100 * c["errors"] / c["calls"], 1) if c["calls"] else None,
                    "wallSec": round(data["tool_secs"].get(name, 0), 1)}
                   for name, c in sorted(data["by_tool"].items(), key=lambda kv: -kv[1]["calls"])],
        "sessions": sorted(
            [{"file": s["file"], "project": s["project"], "category": _category(s["project"]),
              "cwd": s["cwd"],
              "firstMessage": s["first"].isoformat(timespec="seconds") if s["first"] else None,
              "lastMessage": s["last"].isoformat(timespec="seconds") if s["last"] else None,
              "spanHours": round(s["span"] / 3600, 2), "activeHours": round(s["active"] / 3600, 2),
              "pauses": s["pauses"], "idleHours": round(s["idle"] / 3600, 2),
              "resumedAfterStartHours": round(s["resumedHours"], 1) if s["resumedHours"] else None,
              "userMsgs": s["users"], "assistantMsgs": s["assistant"], "toolCalls": s["tools"],
              "toolErrors": s["toolErrors"], "nominalUSD": round(s["nominal"], 3),
              "plans": s["plans"], "models": s["models"]} for s in data["sessions"].values()],
            key=lambda r: -r["nominalUSD"]),
    }

    notes = []
    if report["meta"]["period"]["partial"]:
        notes.append("Period is partial: the end date was clipped to today, so paid and nominal "
                     "cover fewer days than the label suggests.")
    if data["unmapped"]:
        notes.append(f"Providers with no plan mapping (billed as 'unmapped', no fee): "
                     f"{dict(data['unmapped'])} — add them to PLANS.")
    unmapped_cat = sorted(n for n in data["by_project"] if _category(n) == "unmapped")
    if unmapped_cat:
        notes.append(f"Projects with no category mapping (shown as 'unmapped'): {unmapped_cat} "
                     f"— add them to CATEGORIES.")
    if known_active < len(data["sessions"]):
        notes.append(f"Active time comes from ui-turn records (written by the ui-theme turn log); "
                     f"{len(data['sessions']) - known_active} session(s) here have none, so their "
                     f"activeHours is 0 and total active time is a lower bound.")
    notes.append("cacheRead is the prompt cache re-read volume summed over calls, not unique tokens.")
    resumed = sum(1 for s in data["sessions"].values() if (s["resumedHours"] or 0) > 24)
    notes.append(f"{resumed} session file(s) were continued more than a day after their filename "
                 f"timestamp (/resume appends to the same file) — window selection uses mtime and "
                 f"activity is bucketed by message timestamp, so those are counted correctly here.")
    notes.append("Sessions are files, not work units: one project can span many files and one file "
                 "can span days.")
    report["notes"] = notes
    return report


def markdown(rep):
    m, t = rep["meta"], rep["totals"]
    out = []
    out.append(f"# Pi usage — {m['period']['label']}")
    out.append("")
    out.append(f"Collected {m['collectedAt']} · period {m['period']['from']} → "
               f"{m['period']['to']} ({m['period']['days']}d) · "
               f"{m['scan']['sessionsWithActivity']} sessions with activity, "
               f"{m['scan']['megabytes']} MB scanned in {m['scan']['parseSeconds']}s")
    out.append("")
    hours = t["nominalPerActiveHour"]
    lat = " / ".join(f"p{q} {rep['latency'][f'turnP{q}Sec']}s" for q in (50, 90)
                     if rep["latency"][f"turnP{q}Sec"] is not None)
    turns_txt = f"{t['turns']} turns" + (f", {lat}" if lat else "")
    out.append(f"**Nominal API-list spend ${t['nominalUSD']:.2f} vs ${t['paidUSD']:.2f} paid "
               f"→ {t['valueX']}x value.** Active agent time {t['activeHours']} h "
               f"({turns_txt}), "
               f"{t['toolCalls']} tool calls "
               f"({100 * t['toolErrors'] / max(t['toolCalls'], 1):.1f}% errors)"
               + (f", {hours} USD nominal per active hour." if hours is not None else "."))
    out.append("")
    out.append("| plan | nominal $ | paid $ | value | calls | in-tok | out-tok | cache-read |")
    out.append("|---|---|---|---|---|---|---|---|")
    for p in rep["plans"]:
        v = f"{p['valueX']}x" if p["valueX"] else "—"
        paid = f"{p['paidUSD']:.2f}" if p["paidUSD"] is not None else "—"
        out.append(f"| {p['label']} | {p['nominalUSD']:.2f} | {paid} | {v} | {p['calls']} | "
                   f"{p['tokens']['in']:,} | {p['tokens']['out']:,} | {p['tokens']['cread']:,} |")
    out.append("")
    out.append("## Projects")
    out.append("")
    out.append("| project | sessions | user msgs | active h | tool calls | nominal $ |")
    out.append("|---|---|---|---|---|---|")
    for p in rep["byProject"]:
        out.append(f"| {p['project']} | {p['sessions']} | {p['userMsgs']} | {p['activeHours']} | "
                   f"{p['toolCalls']} | {p['nominalUSD']:.2f} |")
    out.append("")
    out.append("## Categories")
    out.append("")
    out.append("| category | projects | sessions | user msgs | active h | tool calls | nominal $ |")
    out.append("|---|---|---|---|---|---|---|")
    for c in rep["byCategory"]:
        out.append(f"| {c['category']} | {c['projectsCount']} | {c['sessions']} | "
                   f"{c['userMsgs']} | {c['activeHours']} | {c['toolCalls']} | "
                   f"{c['nominalUSD']:.2f} |")
    out.append("")
    out.append("## Categories × Models")
    out.append("")
    out.append("| category | model | calls | share | nominal $ |")
    out.append("|---|---|---|---|---|")
    for r in rep["byCategoryModel"]:
        out.append(f"| {r['category']} | {r['model']} | {r['calls']} | "
                   f"{r['shareOfCategoryCallsPct']}% | {r['nominalUSD']:.2f} |")
    out.append("")
    out.append("## Days")
    out.append("")
    out.append("| day | user msgs | assistant msgs | tool calls | active h | nominal $ | grok $ | kimi $ | opencode $ |")
    out.append("|---|---|---|---|---|---|---|---|---|")
    for d in rep["byDay"]:
        pl = d["plansUSD"]
        out.append(f"| {d['date']} | {d['userMsgs']} | {d['assistantMsgs']} | {d['toolCalls']} | "
                   f"{d['activeHours']} | {d['nominalUSD']:.2f} | {pl.get('grok', 0):.2f} | "
                   f"{pl.get('kimi', 0):.2f} | {pl.get('opencode', 0):.2f} |")
    out.append("")
    out.append("## Models")
    out.append("")
    out.append("| provider | model | calls | nominal $ | in-tok | out-tok |")
    out.append("|---|---|---|---|---|---|")
    for mm in rep["byModel"]:
        out.append(f"| {mm['provider']} | {mm['model']} | {mm['calls']} | {mm['nominalUSD']:.2f} | "
                   f"{mm['tokens']['in']:,} | {mm['tokens']['out']:,} |")
    out.append("")
    out.append("## Tools")
    out.append("")
    out.append("| tool | calls | err % | wall h |")
    out.append("|---|---|---|---|")
    for tl in rep["byTool"]:
        out.append(f"| {tl['tool']} | {tl['calls']} | {tl['errorRatePct']} | "
                   f"{tl['wallSec'] / 3600:.2f} |")
    out.append("")
    out.append(f"## Expensive sessions (top 15 of {len(rep['sessions'])})")
    out.append("")
    out.append("| nominal $ | span h | active h | pauses | user msgs | tools | project | file |")
    out.append("|---|---|---|---|---|---|---|---|")
    for s in rep["sessions"][:15]:
        out.append(f"| {s['nominalUSD']:.2f} | {s['spanHours']} | {s['activeHours']} | "
                   f"{s['pauses']} | {s['userMsgs']} | {s['toolCalls']} | {s['project']} | "
                   f"`{s['file'].split(os.sep)[-1][:46]}` |")
    out.append("")
    out.append("## Notes")
    out.append("")
    for n in rep["notes"]:
        out.append(f"- {n}")
    out.append("")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description="Pi session usage / subscription-value stats")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--week", help="this | last | YYYY-Www | any date inside the week")
    ap.add_argument("--month", help="this | last | YYYY-MM")
    ap.add_argument("--from", dest="frm", help="YYYY-MM-DD")
    ap.add_argument("--to", help="YYYY-MM-DD (inclusive)")
    ap.add_argument("--project", help="substring filter on the session folder")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"output directory (default {DEFAULT_OUT})")
    ap.add_argument("--no-write", action="store_true", help="only print the summary line")
    ap.add_argument("--print-md", action="store_true", help="print the Markdown report to stdout")
    a = ap.parse_args()

    if not os.path.isdir(ROOT):
        sys.exit(f"no session directory at {ROOT}")
    lo, hi, label = resolve_period(a)
    data = scan(lo, hi, a.project)
    rep = build_report(a, lo, hi, label, data)

    key = f"{rep['meta']['period']['from']}_{rep['meta']['period']['to']}"
    if a.no_write:
        print(f"{label}: ${rep['totals']['nominalUSD']} nominal vs ${rep['totals']['paidUSD']} paid "
              f"({rep['totals']['valueX']}x), {rep['totals']['activeHours']}h active, "
              f"{len(rep['sessions'])} sessions")
    else:
        os.makedirs(a.out, exist_ok=True)
        stamp = rep["meta"]["collectedAt"][:19].replace(":", "")
        base = f"usage-{key}.collected-{stamp}"
        json_path = os.path.join(a.out, base + ".json")
        md_path = os.path.join(a.out, base + ".md")
        with open(json_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
        with open(md_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(markdown(rep))
        print(f"{label}: ${rep['totals']['nominalUSD']} nominal vs ${rep['totals']['paidUSD']} paid "
              f"({rep['totals']['valueX']}x), {rep['totals']['activeHours']}h active, "
              f"{len(rep['sessions'])} sessions")
        print(f"wrote {json_path}")
        print(f"wrote {md_path}")
    if a.print_md:
        print(markdown(rep))


if __name__ == "__main__":
    main()
