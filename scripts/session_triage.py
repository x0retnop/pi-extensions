#!/usr/bin/env python3
"""Classify Pi session JSONL into junk / likely / review / keep.

Agent-first: default text is a short bucket+project rollup (not 1000 paths).
Full records go to ``--out`` JSON. Apply quarantines (move), never deletes
unless ``--delete`` is also passed.

Examples::

    python scripts/session_triage.py
    python scripts/session_triage.py --json --out _scratch/session-triage.json
    python scripts/session_triage.py --list junk
    python scripts/session_triage.py --apply --bucket junk
    python scripts/session_triage.py --apply --drop-project "10x001-_temp-tmp"
    python scripts/session_triage.py --highlights scratch
    python scripts/session_triage.py --highlights scratch --sort meat
    python scripts/session_triage.py --highlights short          # tiny sessions in ANY project (size-ranked)
    python scripts/session_triage.py --highlights short --max-bytes 30000 --top 40
    python scripts/session_triage.py --rollup stale             # per-project old/dead-cwd table
    python scripts/session_triage.py --project NAME --older 90 --apply   # old sessions of one project
    python scripts/session_triage.py --restore
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

try:
    from pi_session_inspect import extract_project, get_sessions_dir, iter_sessions
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from pi_session_inspect import extract_project, get_sessions_dir, iter_sessions  # type: ignore


# Sessions this large / busy are never auto-junk, even in a temp cwd.
KEEP_MIN_BYTES = 80_000
KEEP_MIN_USERS = 4
KEEP_MIN_TOOLS = 5
WRITE_TOOLS = frozenset({"edit", "multi_edit", "insert", "write"})
PATH_KEYS = frozenset({"path", "file_path", "file", "target", "dest"})
META_TOPICS = frozenset({"docs", "scripts", "tests", "common", "skills", "themes"})
SKIP_TOPICS = frozenset({"node_modules", ".git", "_scratch", ".tests-out", ""})
# This repo: deleted folders that were folded into a living extension.
MERGED_TOPICS = {
    "ascii-banner": "ui-theme",
    "no-working": "ui-theme",
    "smart-footer": "ui-theme",
    "status-box": "ui-theme",
    "status-footer": "ui-theme",
}

# Stub ceiling: above this, a short opener is not enough to junk.
STUB_MAX_BYTES = 12_000

# "short" highlight: sessions this small are eyeballed regardless of project
# (the bucket logic only flags shorts in scratch/dead cwds — live projects slip
# through). Size is the signal; the opener prompt is not (it varies).
SHORT_MAX_BYTES = 60_000
# Default age cut for the stale rollup / --older.
STALE_DAYS = 45

STUB_PROMPT = re.compile(
    r"^(hi|hello|hey|test|testing|ping|pong|ok|ok\.|yo|q|n|y|"
    r"/axi(\s+\S+)?|"
    r"return exactly the word\b.*)$",
    re.I | re.S,
)
SCRATCH_PROJECT = re.compile(
    r"(^|[\\/_-])(_?temp|_?tmp|_tests?|_scratch|-eval)([\\/_-]|$)",
    re.I,
)
SLASH_ONLY = re.compile(r"^/\S+(\s+\S+)*$")

DEFAULT_PROTECT_HOURS = 24
DEFAULT_QUARANTINE = Path.home() / ".pi" / "agent" / "sessions-quarantine"


@dataclass
class SessionRec:
    path: str
    project: str
    bytes: int
    mtime: float
    created: float
    age_days: float
    cwd: str | None
    cwd_exists: bool | None
    session_id: str | None
    users: int
    assistants: int
    tools: int
    writes: int
    entries: int
    first_user: str
    last_user: str
    parse_error: str | None
    scratch_project: bool
    topic: str
    bucket: str
    reasons: list[str] = field(default_factory=list)


def _now() -> float:
    return time.time()


def _parse_created(raw, path: Path, mtime: float) -> float:
    if raw:
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    head = path.name[:10]
    try:
        return datetime.strptime(head, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return mtime


def date_label(ts: float) -> str:
    if not ts:
        return "???? ?? ??"
    return datetime.fromtimestamp(ts).strftime("%Y %m %d")


def _norm_cwd(cwd: str | None) -> str:
    if not cwd:
        return ""
    p = cwd.strip().replace("\\", "/").lower().rstrip("/")
    if p.startswith("/c/"):
        p = "c:" + p[2:]
    return p


def _rel_topic(raw: str, cwd_norm: str) -> str | None:
    if not raw or not cwd_norm:
        return None
    p = raw.strip().strip("\"'").replace("\\", "/").lower()
    if p.startswith("/c/"):
        p = "c:" + p[2:]
    if not p.startswith(cwd_norm + "/"):
        return None
    head = p[len(cwd_norm) + 1 :].split("/", 1)[0]
    if head in SKIP_TOPICS:
        return None
    return head


def _topics_from_args(args, cwd_norm: str, out: list[str]) -> None:
    if isinstance(args, dict):
        for key, val in args.items():
            if key in PATH_KEYS and isinstance(val, str):
                head = _rel_topic(val, cwd_norm)
                if head:
                    out.append(head)
            else:
                _topics_from_args(val, cwd_norm, out)
    elif isinstance(args, list):
        for item in args:
            _topics_from_args(item, cwd_norm, out)


_git_dead: dict[str, set[str]] = {}


def git_dead_topics(cwd: str) -> set[str]:
    """Folder names git deleted (or `_archive/*.zip`) that no longer exist on disk."""
    try:
        top = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    if top.returncode != 0:
        return set()
    repo = top.stdout.strip()
    if repo in _git_dead:
        return _git_dead[repo]
    root = Path(repo)
    dead: set[str] = set()
    archive = root / "_archive"
    if archive.is_dir():
        for zip_path in archive.glob("*.zip"):
            if zip_path.stem != "Inactive" and not (root / zip_path.stem).exists():
                dead.add(zip_path.stem.lower())
    try:
        log = subprocess.run(
            ["git", "-C", repo, "log", "--diff-filter=D", "--name-only", "--pretty=format:"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=45,
        )
        if log.returncode == 0:
            for line in log.stdout.splitlines():
                line = line.strip().replace("\\", "/")
                if not line:
                    continue
                head = line.split("/", 1)[0]
                if head and not (root / head).exists():
                    dead.add(head.lower())
    except (OSError, subprocess.TimeoutExpired):
        pass
    _git_dead[repo] = dead
    return dead


def topic_class(topic: str, cwd: str | None) -> str:
    if not topic:
        return "other"
    if topic in MERGED_TOPICS:
        return "merged"
    if topic in META_TOPICS:
        return "meta"
    if cwd and (Path(cwd) / topic).exists():
        return "live"
    if cwd and topic.lower() in git_dead_topics(cwd):
        return "dead"
    # Old ext name: hyphenated folder that never landed in this tree.
    if cwd and topic and "." not in topic and "-" in topic and not (Path(cwd) / topic).exists():
        return "dead"
    return "other"


def _text_from_content(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            parts.append(item.get("text") or "")
    return "".join(parts)


def _clip(text: str, n: int = 160) -> str:
    text = " ".join(text.split())
    if len(text) <= n:
        return text
    return text[: n - 1] + "…"


def _is_stub_prompt(text: str) -> bool:
    t = text.strip()
    if not t or len(t) <= 3:
        return True
    if STUB_PROMPT.match(t):
        return True
    if SLASH_ONLY.match(t) and len(t) < 48:
        return True
    return False


def _project_is_scratch(project: str, cwd: str | None) -> bool:
    if SCRATCH_PROJECT.search(project.replace("\\", "/")):
        return True
    if cwd and SCRATCH_PROJECT.search(cwd.replace("\\", "/")):
        return True
    return False


def scan_session(path: Path, *, now: float, cwd_cache: dict[str, bool]) -> SessionRec:
    project = extract_project(path)
    try:
        st = path.stat()
        size = st.st_size
        mtime = st.st_mtime
    except OSError as exc:
        return SessionRec(
            path=str(path),
            project=project,
            bytes=0,
            mtime=0,
            created=0,
            age_days=0,
            cwd=None,
            cwd_exists=None,
            session_id=None,
            users=0,
            assistants=0,
            tools=0,
            writes=0,
            entries=0,
            first_user="",
            last_user="",
            parse_error=str(exc),
            scratch_project=_project_is_scratch(project, None),
            topic="",
            bucket="junk",
            reasons=["unreadable"],
        )

    cwd: str | None = None
    session_id: str | None = None
    created_raw = None
    cwd_norm = ""
    topic_hits: Counter[str] = Counter()
    topic_writes: Counter[str] = Counter()
    users = assistants = tools = writes = entries = 0
    first_user = ""
    last_user = ""
    parse_error: str | None = None
    has_compaction = False

    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                raw = line.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                entries += 1
                typ = obj.get("type")
                if typ == "session":
                    cwd = obj.get("cwd") or cwd
                    cwd_norm = _norm_cwd(cwd)
                    session_id = obj.get("id") or session_id
                    created_raw = obj.get("timestamp") or created_raw
                    continue
                if typ == "compaction":
                    has_compaction = True
                    continue
                if typ != "message":
                    continue
                msg = obj.get("message") or {}
                role = msg.get("role")
                content = msg.get("content")
                if role == "user":
                    users += 1
                    text = _text_from_content(content)
                    if text.strip():
                        if not first_user:
                            first_user = text
                        last_user = text
                elif role == "assistant":
                    assistants += 1
                    if isinstance(content, list):
                        for item in content:
                            if isinstance(item, dict) and item.get("type") == "toolCall":
                                tools += 1
                                is_write = item.get("name") in WRITE_TOOLS
                                if is_write:
                                    writes += 1
                                found: list[str] = []
                                _topics_from_args(item.get("arguments") or {}, cwd_norm, found)
                                for head in found:
                                    topic_hits[head] += 1
                                    if is_write:
                                        topic_writes[head] += 1
    except OSError as exc:
        parse_error = str(exc)

    cwd_exists: bool | None = None
    if cwd:
        if cwd not in cwd_cache:
            try:
                cwd_cache[cwd] = Path(cwd).exists()
            except OSError:
                cwd_cache[cwd] = False
        cwd_exists = cwd_cache[cwd]

    scratch = _project_is_scratch(project, cwd)
    rec = SessionRec(
        path=str(path),
        project=project,
        bytes=size,
        mtime=mtime,
        created=_parse_created(created_raw, path, mtime),
        age_days=round((now - mtime) / 86400, 2),
        cwd=cwd,
        cwd_exists=cwd_exists,
        session_id=session_id,
        users=users,
        assistants=assistants,
        tools=tools,
        writes=writes,
        entries=entries,
        first_user=_clip(first_user),
        last_user=_clip(last_user) if last_user != first_user else "",
        parse_error=parse_error,
        scratch_project=scratch,
        topic=(
            topic_writes.most_common(1)[0][0]
            if topic_writes
            else topic_hits.most_common(1)[0][0]
            if topic_hits
            else ""
        ),
        bucket="keep",
        reasons=[],
    )
    rec.bucket, rec.reasons = classify(rec, has_compaction=has_compaction)
    return rec


def classify(rec: SessionRec, *, has_compaction: bool) -> tuple[str, list[str]]:
    reasons: list[str] = []
    if rec.parse_error:
        return "junk", ["unreadable"]
    if rec.entries == 0 or rec.bytes < 200:
        return "junk", ["empty"]

    meaty = (
        has_compaction
        or rec.bytes >= KEEP_MIN_BYTES
        or rec.users >= KEEP_MIN_USERS
        or rec.tools >= KEEP_MIN_TOOLS
    )
    stubby = (
        rec.bytes <= STUB_MAX_BYTES
        and rec.tools == 0
        and rec.users <= 1
        and rec.assistants <= 1
    )

    if not meaty:
        if rec.users == 0 and rec.tools == 0:
            reasons.append("no_user")
        if stubby and _is_stub_prompt(rec.first_user):
            reasons.append("stub_prompt")
        if stubby and rec.assistants == 0:
            reasons.append("aborted")
        if reasons:
            return "junk", reasons

    if rec.scratch_project:
        reasons.append("scratch_cwd")
    if rec.cwd_exists is False:
        reasons.append("cwd_missing")

    if not reasons:
        return "keep", ["active"]

    # Historical meat in a dead/temp cwd — do not auto-drop.
    if meaty:
        return "review", reasons + ["meaty"]

    smallish = rec.bytes < KEEP_MIN_BYTES and rec.users < KEEP_MIN_USERS and rec.tools < 8
    if smallish:
        return "likely", reasons + ["small"]
    return "review", reasons


def empty_project_dirs(sessions_dir: Path) -> list[str]:
    out: list[str] = []
    if not sessions_dir.is_dir():
        return out
    for d in sorted(sessions_dir.iterdir()):
        if not d.is_dir():
            continue
        if not any(d.rglob("*.jsonl")):
            out.append(str(d))
    return out


def build_report(
    recs: list[SessionRec],
    *,
    empty_dirs: list[str],
    protect_hours: float,
    now: float,
) -> dict:
    by_bucket: dict[str, list[SessionRec]] = defaultdict(list)
    for r in recs:
        by_bucket[r.bucket].append(r)

    def rollup(items: list[SessionRec], top: int = 12) -> dict:
        projects: dict[str, dict] = {}
        for r in items:
            slot = projects.setdefault(
                r.project,
                {"project": r.project, "files": 0, "bytes": 0, "newest_age_days": r.age_days},
            )
            slot["files"] += 1
            slot["bytes"] += r.bytes
            slot["newest_age_days"] = min(slot["newest_age_days"], r.age_days)
        ranked = sorted(projects.values(), key=lambda x: -x["bytes"])
        return {
            "files": len(items),
            "bytes": sum(r.bytes for r in items),
            "projects": ranked[:top],
            "project_count": len(projects),
        }

    protect_cut = now - protect_hours * 3600
    protected = [r for r in recs if r.mtime >= protect_cut]

    project_view = []
    by_proj: dict[str, list[SessionRec]] = defaultdict(list)
    for r in recs:
        by_proj[r.project].append(r)
    for name, items in sorted(by_proj.items(), key=lambda kv: -sum(x.bytes for x in kv[1])):
        buckets = Counter(r.bucket for r in items)
        project_view.append(
            {
                "project": name,
                "files": len(items),
                "bytes": sum(r.bytes for r in items),
                "buckets": dict(buckets),
                "scratch": any(r.scratch_project for r in items),
                "cwd_missing": all(r.cwd_exists is False for r in items),
                "newest_age_days": min(r.age_days for r in items),
            }
        )

    return {
        "meta": {
            "generated_at": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
            "sessions_dir": str(get_sessions_dir()),
            "files": len(recs),
            "bytes": sum(r.bytes for r in recs),
            "projects": len(by_proj),
            "empty_dirs": empty_dirs,
            "protect_hours": protect_hours,
            "protected_files": len(protected),
        },
        "buckets": {k: rollup(by_bucket.get(k, [])) for k in ("junk", "likely", "review", "keep")},
        "projects": project_view,
        "sessions": [asdict(r) for r in recs],
    }


def print_text(report: dict) -> None:
    meta = report["meta"]
    print(
        f"sessions {meta['files']}  projects {meta['projects']}  "
        f"{meta['bytes'] / 1e6:.1f} MB  empty_dirs {len(meta['empty_dirs'])}  "
        f"protected(<{meta['protect_hours']}h) {meta['protected_files']}"
    )
    for name in ("junk", "likely", "review", "keep"):
        b = report["buckets"][name]
        print(f"\n[{name}] {b['files']} files  {b['bytes'] / 1e6:.1f} MB  {b['project_count']} projects")
        for p in b["projects"][:8]:
            print(
                f"  {p['bytes'] / 1e6:6.1f} MB  n={p['files']:3d}  "
                f"age_d={p['newest_age_days']:6.1f}  {p['project']}"
            )
    if meta["empty_dirs"]:
        print("\n[empty_dirs]")
        for d in meta["empty_dirs"]:
            print(f"  {d}")

    drop_whole = [
        p
        for p in report["projects"]
        if p["files"] and p["buckets"].get("keep", 0) == 0 and p["buckets"].get("review", 0) == 0
    ]
    if drop_whole:
        print("\n[all-junk projects] no keep/review left")
        for p in drop_whole:
            print(
                f"  {p['bytes'] / 1024:7.1f} KB  n={p['files']:3d}  "
                f"{p['project']}"
            )
    print("\nnext: python scripts/session_triage.py --apply --bucket junk")
    print("      python scripts/session_triage.py --list likely")
    print("      python scripts/session_triage.py --highlights short     # tiny/broken, any project")
    print("      python scripts/session_triage.py --rollup stale         # old per project, cwd aware")
    print("      review bucket is historical meat — do not apply unless named")


def list_bucket(recs: list[SessionRec], bucket: str) -> None:
    for r in recs:
        if r.bucket != bucket:
            continue
        why = ",".join(r.reasons)
        print(f"{r.bytes:8d}  {r.age_days:6.1f}d  {r.project}  {why}  {r.path}")


def _size(n: int) -> str:
    if n < 10_000:
        return f"{n}B"
    if n < 1_000_000:
        return f"{n / 1024:.0f}KB"
    return f"{n / 1e6:.2f}MB"


def meat_score(rec: SessionRec) -> int:
    """Higher = more likely a real working session, not a poke."""
    return (
        rec.bytes
        + rec.writes * 50_000
        + rec.users * 12_000
        + rec.tools * 4_000
        + min(len(rec.first_user), 160) * 80
    )


def scratch_candidates(recs: list[SessionRec]) -> list[SessionRec]:
    return [r for r in recs if r.scratch_project and r.bucket != "junk"]


def short_candidates(recs: list[SessionRec], max_bytes: int) -> list[SessionRec]:
    """Every small session, any project — including live projects the buckets
    leave alone. Broken/empty files are shown too (flagged), not hidden."""
    return [r for r in recs if r.bytes <= max_bytes]


def resolve_sort(kind: str, sort: str | None) -> str:
    """The ordering actually used for ``kind`` — and the one printed, so the
    header never labels size-ranked rows as 'meat'."""
    if kind == "short":
        return "date" if sort == "date" else "size"
    return "meat" if sort in ("meat", "size") else "date"


def rank_highlights(
    recs: list[SessionRec],
    *,
    sort: str,
    kind: str = "scratch",
    max_bytes: int = SHORT_MAX_BYTES,
) -> list[SessionRec]:
    if kind == "short":
        cands = short_candidates(recs, max_bytes)
        if sort == "date":
            return sorted(cands, key=lambda r: r.created or r.mtime, reverse=True)
        # size (default): smallest first — the top of the list is the discard pile.
        return sorted(cands, key=lambda r: (r.bytes, -r.writes))
    cands = scratch_candidates(recs)
    if sort == "meat":
        return sorted(cands, key=meat_score, reverse=True)
    return sorted(cands, key=lambda r: r.created or r.mtime, reverse=True)


def _short_flags(r: SessionRec) -> str:
    flags = []
    if r.parse_error or r.entries == 0:
        flags.append("broken")
    elif r.users > 0 and r.assistants == 0:
        flags.append("no-reply")
    if r.users <= 1 and r.tools == 0:
        flags.append("one-shot")
    if r.writes == 0:
        flags.append("no-write")
    if r.cwd_exists is False:
        flags.append("cwd-gone")
    return ",".join(flags)


def print_highlights(
    recs: list[SessionRec],
    *,
    top: int,
    sort: str,
    kind: str = "scratch",
    max_bytes: int = SHORT_MAX_BYTES,
) -> None:
    ranked = rank_highlights(recs, sort=sort, kind=kind, max_bytes=max_bytes)
    shown = ranked[:top]
    rest = ranked[top:]
    label = "short" if kind == "short" else "scratch"
    scope = f"<= {max_bytes // 1000}KB" if kind == "short" else ""
    head = (
        f"[{label} highlights] {len(ranked)} candidates  "
        f"{sum(r.bytes for r in ranked) / 1e6:.1f} MB"
    )
    if scope:
        head += f"  {scope}"
    print(f"{head}  sort={sort}  showing {len(shown)}")
    for i, r in enumerate(shown, 1):
        flags = _short_flags(r) if kind == "short" else ""
        tail = f"  {flags}" if flags else ""
        print(
            f"{i:2d}  {date_label(r.created)}  {_size(r.bytes):>7}  "
            f"u={r.users:<3d} t={r.tools:<4d} w={r.writes:<3d}  "
            f"{r.bucket:6}  {r.project}{tail}"
        )
        print(f"    {r.first_user or '(no user text)'}")
        if r.last_user:
            print(f"    last: {r.last_user}")
    if rest:
        hint = " or --sort meat" if kind != "short" else ""
        print(
            f"below-cut: {len(rest)} files  {sum(r.bytes for r in rest) / 1e6:.2f} MB  "
            f"(use --top {len(ranked)}{hint})"
        )


def print_rollup(recs: list[SessionRec], *, kind: str, now: float) -> None:
    """Project or project×month totals — the unit for bulk keep/drop."""
    if kind == "month":
        groups: dict[tuple[str, str], dict] = defaultdict(
            lambda: {"n": 0, "bytes": 0, "last": 0.0}
        )
        for rec in recs:
            ts = rec.created or rec.mtime
            key = (rec.project, date_label(ts)[:7])
            slot = groups[key]
            slot["n"] += 1
            slot["bytes"] += rec.bytes
            slot["last"] = max(slot["last"], ts)
        print(f"[rollup month] {len(groups)} project-months  {sum(r.bytes for r in recs) / 1e6:.1f} MB")
        for (proj, mon), slot in sorted(groups.items(), key=lambda kv: (-kv[1]["bytes"], kv[0])):
            if slot["n"] < 3 and slot["bytes"] < 1_000_000:
                continue
            print(f"  {mon}  n={slot['n']:3d}  {slot['bytes'] / 1e6:6.1f}MB  {proj}")
        return

    by: dict[str, dict] = {}
    for rec in recs:
        ts = rec.created or rec.mtime
        slot = by.setdefault(rec.project, {"n": 0, "bytes": 0, "last": 0.0})
        slot["n"] += 1
        slot["bytes"] += rec.bytes
        slot["last"] = max(slot["last"], ts)

    bands = {"hot": [], "warm": [], "cold": []}
    for name, slot in by.items():
        age = (now - slot["last"]) / 86400 if slot["last"] else 999
        band = "hot" if age < 14 else "warm" if age < 45 else "cold"
        bands[band].append((name, slot, age))

    print(
        f"[rollup age] hot<14d warm<45d cold>=45d  "
        f"{len(recs)} files  {sum(r.bytes for r in recs) / 1e6:.1f} MB"
    )
    for band in ("hot", "warm", "cold"):
        items = sorted(bands[band], key=lambda x: -x[1]["bytes"])
        n = sum(s["n"] for _, s, _ in items)
        b = sum(s["bytes"] for _, s, _ in items)
        print(f"\n[{band}] {len(items)} projects  {n} files  {b / 1e6:.1f} MB")
        for name, slot, _age in items:
            print(
                f"  {date_label(slot['last'])}  n={slot['n']:3d}  "
                f"{slot['bytes'] / 1e6:6.1f}MB  {name}"
            )


def print_rollup_stale(recs: list[SessionRec], *, now: float, stale_days: int) -> None:
    """Per-project staleness table. Old *and* cwd-gone is the actionable pair;
    old but cwd-alive is a project the user just runs rarely."""
    by: dict[str, dict] = {}
    for rec in recs:
        slot = by.setdefault(
            rec.project,
            {"n": 0, "bytes": 0, "old_n": 0, "old_bytes": 0, "last": 0.0,
             "bands": Counter(), "cwd": Counter()},
        )
        ts = rec.created or rec.mtime
        slot["n"] += 1
        slot["bytes"] += rec.bytes
        slot["last"] = max(slot["last"], ts)
        slot["cwd"]["dead" if rec.cwd_exists is False else "alive" if rec.cwd_exists else "?"] += 1
        if rec.age_days >= stale_days:
            slot["old_n"] += 1
            slot["old_bytes"] += rec.bytes
        if rec.age_days >= 180:
            slot["bands"][">180d"] += 1
        elif rec.age_days >= 90:
            slot["bands"][">90d"] += 1

    def cwd_state(slot: dict) -> str:
        if slot["cwd"].get("dead") and not slot["cwd"].get("alive"):
            return "dead"
        if slot["cwd"].get("alive"):
            return "alive"
        return "?"

    rows = sorted(by.items(), key=lambda kv: -kv[1]["old_bytes"])
    stale_rows = [(n, s) for n, s in rows if s["old_n"]]
    tot_old = sum(s["old_n"] for _, s in stale_rows)
    tot_old_b = sum(s["old_bytes"] for _, s in stale_rows)
    print(
        f"[rollup stale] older-than {stale_days}d  {len(stale_rows)}/{len(rows)} projects  "
        f"{tot_old} files  {tot_old_b / 1e6:.1f} MB  (cwd=all sessions' folder state)"
    )
    for name, slot in stale_rows:
        newest = date_label(slot["last"])
        older = (now - slot["last"]) / 86400 if slot["last"] else 999
        if slot["bands"][">90d"] or slot["bands"][">180d"]:
            tt = f"  >90d:{slot['bands']['>90d']:3d}  >180d:{slot['bands']['>180d']:3d}"
        else:
            tt = ""
        print(
            f"  newest {newest} ({older:4.0f}d)  cwd={cwd_state(slot):5}  "
            f"n_old={slot['old_n']:3d}  {slot['old_bytes'] / 1e6:6.1f}MB  {name}{tt}"
        )
    print("\nnext: python scripts/session_triage.py --project NAME --older 90        # dry-run")
    print("      python scripts/session_triage.py --project NAME --older 90 --apply")
    print("      cwd=dead → folder gone, strong drop;  cwd=alive → project runs rarely, your call")


def print_rollup_git(recs: list[SessionRec]) -> None:
    """Group by git fate of the session's primary folder (dead / merged / live / meta)."""
    groups: dict[str, dict] = {}
    for rec in recs:
        klass = topic_class(rec.topic, rec.cwd)
        slot = groups.setdefault(klass, {"n": 0, "bytes": 0, "topics": Counter()})
        slot["n"] += 1
        slot["bytes"] += rec.bytes
        slot["topics"][rec.topic or "(none)"] += 1
    print(
        f"[rollup git] {len(recs)} files  {sum(r.bytes for r in recs) / 1e6:.1f} MB  "
        f"(topic = folder the session wrote most)"
    )
    for klass in ("dead", "merged", "meta", "live", "other"):
        slot = groups.get(klass)
        if not slot:
            continue
        print(f"\n[{klass}] {slot['n']} files  {slot['bytes'] / 1e6:.1f} MB")
        for topic, n in slot["topics"].most_common():
            tb = sum(r.bytes for r in recs if (r.topic or "(none)") == topic and topic_class(r.topic, r.cwd) == klass)
            d0 = min((date_label(r.created) for r in recs if (r.topic or "(none)") == topic), default="")
            d1 = max((date_label(r.created) for r in recs if (r.topic or "(none)") == topic), default="")
            extra = f" → {MERGED_TOPICS[topic]}" if topic in MERGED_TOPICS else ""
            print(f"  {d0} .. {d1}  n={n:3d}  {tb / 1e6:5.1f}MB  {topic}{extra}")
    print("\nnext: python scripts/session_triage.py --project NAME --apply --drop-topic dead")
    print("      or --drop-topic agent-browser --drop-topic auto-trust")


def _rel_under(path: Path, root: Path) -> Path:
    try:
        return path.resolve().relative_to(root.resolve())
    except ValueError:
        return Path(path.name)


def select_targets(
    recs: list[SessionRec],
    *,
    buckets: set[str],
    drop_projects: set[str],
    keep_projects: set[str],
    drop_sessions: set[str],
    drop_topics: set[str],
    older_days: float | None = None,
) -> list[SessionRec]:
    drop_paths = set()
    for raw in drop_sessions:
        try:
            drop_paths.add(str(Path(raw).resolve()))
        except OSError:
            drop_paths.add(str(Path(raw)))
    out: list[SessionRec] = []
    for rec in recs:
        if rec.project in keep_projects:
            continue
        try:
            rec_path = str(Path(rec.path).resolve())
        except OSError:
            rec_path = rec.path
        topic_hit = False
        if drop_topics:
            klass = topic_class(rec.topic, rec.cwd)
            topic_l = (rec.topic or "").lower()
            topic_hit = topic_l in drop_topics or klass in drop_topics
        # older_days is scoped by the caller's --project scan; it never widens
        # beyond the sessions already under consideration.
        old_hit = older_days is not None and rec.age_days >= older_days
        if (
            rec.project in drop_projects
            or rec.bucket in buckets
            or rec_path in drop_paths
            or topic_hit
            or old_hit
        ):
            out.append(rec)
    return out


def apply_actions(
    recs: list[SessionRec],
    *,
    buckets: set[str],
    drop_projects: set[str],
    keep_projects: set[str],
    drop_sessions: set[str],
    drop_topics: set[str],
    empty_dirs: list[str],
    protect_hours: float,
    now: float,
    quarantine: Path,
    delete: bool,
    dry_run: bool,
    older_days: float | None = None,
) -> dict:
    protect_cut = now - protect_hours * 3600
    moved, skipped, errors = [], [], []
    sessions_dir = get_sessions_dir()

    targets = select_targets(
        recs,
        buckets=buckets,
        drop_projects=drop_projects,
        keep_projects=keep_projects,
        drop_sessions=drop_sessions,
        drop_topics=drop_topics,
        older_days=older_days,
    )
    for r in targets:
        src = Path(r.path)
        if r.mtime >= protect_cut:
            skipped.append({"path": r.path, "reason": "protected"})
            continue
        dest = quarantine / _rel_under(src, sessions_dir)
        action = "delete" if delete else "quarantine"
        entry = {
            "path": r.path,
            "dest": str(dest),
            "action": action,
            "bucket": r.bucket,
            "project": r.project,
            "bytes": r.bytes,
        }
        if dry_run:
            moved.append(entry)
            continue
        try:
            if delete:
                src.unlink()
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                if dest.exists():
                    dest = dest.with_name(dest.stem + f"_{int(now)}" + dest.suffix)
                    entry["dest"] = str(dest)
                shutil.move(str(src), str(dest))
            moved.append(entry)
        except OSError as exc:
            errors.append({"path": r.path, "error": str(exc)})

    removed_dirs = []
    extra_empty = []
    recs_by_parent: dict[str, int] = defaultdict(int)
    for rec in recs:
        recs_by_parent[str(Path(rec.path).parent)] += 1
    moved_by_parent: dict[str, int] = defaultdict(int)
    for entry in moved:
        moved_by_parent[str(Path(entry["path"]).parent)] += 1
    for parent, n in moved_by_parent.items():
        if n and n == recs_by_parent.get(parent, 0):
            extra_empty.append(parent)
    if not dry_run:
        for parent in list(extra_empty):
            p = Path(parent)
            try:
                if p.is_dir() and any(p.rglob("*.jsonl")):
                    extra_empty.remove(parent)
            except OSError:
                continue
    for d in dict.fromkeys([*empty_dirs, *extra_empty]):
        p = Path(d)
        entry = {"path": d, "action": "rmdir"}
        if dry_run:
            removed_dirs.append(entry)
            continue
        try:
            p.rmdir()
            removed_dirs.append(entry)
        except OSError as exc:
            errors.append({"path": d, "error": str(exc)})

    result = {
        "dry_run": dry_run,
        "delete": delete,
        "quarantine": str(quarantine),
        "moved": moved,
        "removed_dirs": removed_dirs,
        "skipped": skipped,
        "errors": errors,
    }
    if not dry_run and not delete and moved:
        quarantine.mkdir(parents=True, exist_ok=True)
        manifest = quarantine / "manifest.json"
        payload = {
            "at": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
            "sessions_dir": str(sessions_dir),
            **result,
        }
        # Append-friendly: keep previous manifests.
        stamp = datetime.fromtimestamp(now, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        stamped = quarantine / f"manifest-{stamp}.json"
        stamped.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        manifest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def restore(quarantine: Path, *, dry_run: bool) -> dict:
    sessions_dir = get_sessions_dir()
    if not quarantine.is_dir():
        return {"restored": [], "errors": [{"error": f"no quarantine at {quarantine}"}]}
    restored, errors = [], []
    for src in quarantine.rglob("*.jsonl"):
        rel = _rel_under(src, quarantine)
        dest = sessions_dir / rel
        entry = {"src": str(src), "dest": str(dest)}
        if dry_run:
            restored.append(entry)
            continue
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                errors.append({"src": str(src), "error": "dest exists"})
                continue
            shutil.move(str(src), str(dest))
            restored.append(entry)
        except OSError as exc:
            errors.append({"src": str(src), "error": str(exc)})
    return {"dry_run": dry_run, "restored": restored, "errors": errors}


def print_apply(result: dict) -> None:
    verb = "would move" if result.get("dry_run") else ("deleted" if result.get("delete") else "moved")
    if "restored" in result:
        verb = "would restore" if result.get("dry_run") else "restored"
        print(f"{verb} {len(result['restored'])}  errors {len(result.get('errors') or [])}")
        return
    n = len(result["moved"])
    b = sum(e.get("bytes") or 0 for e in result["moved"])
    print(
        f"{verb} {n} files  {b / 1e6:.2f} MB  "
        f"rmdir {len(result['removed_dirs'])}  "
        f"skipped {len(result['skipped'])}  "
        f"errors {len(result['errors'])}"
    )
    by: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for e in result["moved"]:
        slot = by[e.get("project") or "?"]
        slot[0] += 1
        slot[1] += e.get("bytes") or 0
    for name, (cnt, nbytes) in sorted(by.items(), key=lambda kv: -kv[1][1])[:12]:
        print(f"  {nbytes / 1e6:6.2f} MB  n={cnt:3d}  {name}")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    parser = argparse.ArgumentParser(description="Triage Pi session JSONL into junk/likely/review/keep.")
    parser.add_argument("session", nargs="?", help="Single .jsonl (optional)")
    parser.add_argument("--project", help="Filter by project folder name")
    parser.add_argument("--since", type=int, metavar="DAYS", help="Only sessions modified in last N days")
    parser.add_argument("--recent", type=int, metavar="N", help="Only N newest sessions")
    parser.add_argument("--json", action="store_true", help="Structured JSON (use --out for the full dump)")
    parser.add_argument("--out", type=Path, help="Write JSON report to this path")
    parser.add_argument("--list", metavar="BUCKET", help="Print paths in this bucket (junk|likely|review|keep)")
    parser.add_argument(
        "--highlights",
        metavar="KIND",
        help="Ranked one-liners: scratch (leftover in temp/test cwds) or "
        "short (small sessions in ANY project, size-ranked)",
    )
    parser.add_argument("--top", type=int, default=15, help="How many highlight rows (default 15)")
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=SHORT_MAX_BYTES,
        help=f"--highlights short size ceiling (default {SHORT_MAX_BYTES})",
    )
    parser.add_argument(
        "--sort",
        choices=("date", "meat", "size"),
        default=None,
        help="Highlights order: scratch=date|meat, short=size (smallest first)|date. "
        "Default depends on --highlights.",
    )
    parser.add_argument(
        "--rollup",
        metavar="KIND",
        help="Bulk decision table: age (hot/warm/cold), month, or stale (per-project old/dead-cwd)",
    )
    parser.add_argument(
        "--stale-days",
        type=int,
        default=STALE_DAYS,
        help=f"--rollup stale age cut (default {STALE_DAYS})",
    )
    parser.add_argument(
        "--older",
        type=int,
        metavar="DAYS",
        help="With --project: also select sessions older than DAYS for apply (dry-run first)",
    )
    parser.add_argument(
        "--drop-session",
        action="append",
        default=[],
        dest="drop_sessions",
        help="Apply this session file (repeatable). For mixed scratch folders.",
    )
    parser.add_argument(
        "--drop-topic",
        action="append",
        default=[],
        dest="drop_topics",
        help="Apply sessions whose primary folder is this topic or class (dead|merged|…)",
    )
    parser.add_argument("--apply", action="store_true", help="Execute (default is still quarantine, not delete)")
    parser.add_argument(
        "--bucket",
        action="append",
        dest="buckets",
        help="Bucket to apply (repeatable). Default: junk, unless --drop-project is set",
    )
    parser.add_argument(
        "--drop-project",
        action="append",
        default=[],
        dest="drop_projects",
        help="Apply ALL sessions in this project (repeatable). Decision unit for cancelled work.",
    )
    parser.add_argument(
        "--keep-project",
        action="append",
        default=[],
        dest="keep_projects",
        help="Never apply this project (repeatable)",
    )
    parser.add_argument("--delete", action="store_true", help="With --apply: unlink instead of quarantine")
    parser.add_argument(
        "--quarantine",
        type=Path,
        default=DEFAULT_QUARANTINE,
        help=f"Quarantine root (default {DEFAULT_QUARANTINE})",
    )
    parser.add_argument("--restore", action="store_true", help="Move quarantined jsonl back")
    parser.add_argument(
        "--protect-hours",
        type=float,
        default=DEFAULT_PROTECT_HOURS,
        help="Skip files newer than this on apply (default 24)",
    )
    args = parser.parse_args()

    now = _now()

    if args.restore:
        result = restore(args.quarantine, dry_run=not args.apply)
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print_apply(result)
        return 1 if result.get("errors") else 0

    paths = [Path(args.session)] if args.session else None
    recs: list[SessionRec] = []
    cwd_cache: dict[str, bool] = {}
    for p in iter_sessions(
        recent=args.recent,
        since_days=args.since,
        project=args.project,
        paths=paths,
    ):
        recs.append(scan_session(p, now=now, cwd_cache=cwd_cache))

    empty_dirs = [] if paths or args.project else empty_project_dirs(get_sessions_dir())
    report = build_report(recs, empty_dirs=empty_dirs, protect_hours=args.protect_hours, now=now)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")

    if args.apply or args.delete or args.drop_projects or args.drop_sessions or args.drop_topics or args.older is not None:
        if args.older is not None and (not args.project or args.session):
            print("--older needs --project NAME and no positional session (it selects old sessions of one project)", file=sys.stderr)
            return 2
        if args.buckets:
            buckets = set(args.buckets)
        elif args.drop_projects or args.drop_sessions or args.drop_topics or args.older is not None:
            buckets = set()
        else:
            buckets = {"junk"}
        unknown = buckets - {"junk", "likely", "review", "keep"}
        if unknown:
            print(f"unknown bucket(s): {sorted(unknown)}", file=sys.stderr)
            return 2
        if ("keep" in buckets or "review" in buckets) and not args.drop_projects:
            print("refusing to apply keep/review — use --drop-project NAME", file=sys.stderr)
            return 2
        def _norm_proj(name: str) -> str:
            name = name.strip()
            if name.startswith("--C--") and name.endswith("--"):
                return name[5:-2]
            return name

        result = apply_actions(
            recs,
            buckets=buckets,
            drop_projects={_norm_proj(x) for x in args.drop_projects},
            keep_projects={_norm_proj(x) for x in args.keep_projects},
            drop_sessions=set(args.drop_sessions),
            drop_topics={x.strip().lower() for x in args.drop_topics},
            empty_dirs=empty_dirs if "junk" in buckets else [],
            protect_hours=args.protect_hours,
            now=now,
            quarantine=args.quarantine,
            delete=bool(args.delete),
            dry_run=not args.apply,
            older_days=float(args.older) if args.older is not None else None,
        )
        if args.json and not args.out:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print_apply(result)
        return 1 if result["errors"] else 0

    if args.rollup:
        kind = args.rollup.strip().lower()
        if kind not in {"age", "month", "git", "stale"}:
            print(f"unknown rollup: {args.rollup}", file=sys.stderr)
            return 2
        if kind == "git":
            print_rollup_git(recs)
        elif kind == "stale":
            print_rollup_stale(recs, now=now, stale_days=args.stale_days)
        else:
            print_rollup(recs, kind=kind, now=now)
        return 0

    if args.highlights:
        kind = args.highlights.strip().lower()
        if kind not in {"scratch", "short"}:
            print(f"unknown highlights kind: {args.highlights}", file=sys.stderr)
            return 2
        sort = resolve_sort(kind, args.sort)
        if args.json:
            cands = rank_highlights(recs, sort=sort, kind=kind, max_bytes=args.max_bytes)
            payload = {
                "kind": kind,
                "sort": sort,
                "shown": [
                    asdict(r)
                    | {
                        "score": meat_score(r),
                        "date": date_label(r.created),
                        "flags": _short_flags(r) if kind == "short" else "",
                    }
                    for r in cands[: args.top]
                ],
                "rest_files": max(0, len(cands) - args.top),
                "rest_bytes": sum(r.bytes for r in cands[args.top :]),
            }
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print_highlights(
                recs, top=args.top, sort=sort, kind=kind, max_bytes=args.max_bytes
            )
        return 0

    if args.list:
        list_bucket(recs, args.list)
        return 0

    if args.json and not args.out:
        # Compact: drop per-session dump unless they asked for --out.
        slim = {k: report[k] for k in ("meta", "buckets", "projects")}
        print(json.dumps(slim, ensure_ascii=False, indent=2))
        return 0

    print_text(report)
    if args.out:
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
