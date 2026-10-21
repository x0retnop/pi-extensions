#!/usr/bin/env python3
"""P-6b: blank the built-in provider model catalogs that this host never uses.

The live CLI bundle inlines the model catalog of all ~40 built-in providers as
top-level `var <provider>_default={...};` statements (~450 KB of data, ~1300
model objects). Top-level code is always parsed and evaluated at startup, so
every `pi` start pays for catalogs that are never selected.

This script replaces the data of the *unused* providers with `{}` and leaves
everything else alone: `<flattener>("<id>", <groups var>)` then yields an empty
model list. Providers still register, so nothing that resolves a provider by id
breaks - they simply expose no models.

Two bundle layouts are supported: 0.84 `var <id>_default={...}` fed to
`flattenModelCatalog("<id>", <var>)`, and 0.99+ where one shared groups var feeds
`flattenChatModelCatalog` / `...Image...` / `...Classifier...`.

Keep list: any provider that this host's `models.json` / `model-manager.json`
depends on is kept automatically (a built-in provider whose custom models rely
on the catalog for `api`/`baseUrl` must not be blanked - composition throws),
plus a keep-list read from `pi-runtime-decat.keep.json` (private, host data).

Usage:
  python scripts/pi_runtime_decat.py                 # dry run, prints the plan
  python scripts/pi_runtime_decat.py --apply         # writes (timestamped backup)
  python scripts/pi_runtime_decat.py --revert        # restores the newest backup
  python scripts/pi_runtime_decat.py --keep xai,deepseek
  python scripts/pi_runtime_decat.py --root <dir>    # operate on a bundle copy

Re-run after every `npm i -g @earendil-works/pi-coding-agent` (the patch is
wiped, like P-1..P-5). Registry: docs/runtime-patches.md
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
DEFAULT_ROOT = Path(os.environ.get("APPDATA", "")) / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent"
AGENT_DIR = Path(os.environ.get("PI_CODING_AGENT_DIR") or (HOME / ".pi" / "agent"))
# Which built-in provider catalogs stay live is host data, not code: it says who this machine
# actually talks to, so it lives in a private file next to the script (gitignored, unpublished).
# `keep` = providers used day to day; `keepExtra` = kept by choice, not by use.
KEEP_CONFIG = Path(__file__).resolve().parent / "pi-runtime-decat.keep.json"


def _load_keep() -> tuple[set, set]:
    try:
        data = json.loads(KEEP_CONFIG.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return set(), set()
    return set(data.get("keep", [])), set(data.get("keepExtra", []))


STATIC_KEEP, STATIC_KEEP_EXTRA = _load_keep()

CALL_RE = re.compile(r'var ([A-Za-z0-9_$]+)=flatten(?:Chat|Image|Classifier)ModelCatalog\("([a-z0-9-]+)",([A-Za-z0-9_$]+)\)')
GENERIC_CALL_RE = re.compile(r'var ([A-Za-z0-9_$]+)=flattenModelCatalog\("([a-z0-9-]+)",([A-Za-z0-9_$]+)\)')
# Both layouts wire one shared `<provider>_default` groups var into every type flattener
# (chat/image/classifier) since 0.99, so matches must be deduped by groups var.
CATALOG_MARKERS = ('flattenChatModelCatalog("', 'flattenModelCatalog("')


def log(msg: str = "") -> None:
    print(msg, flush=True)


def find_bundle_chunk(root: Path) -> Path:
    """The live CLI chunk that carries the inlined provider catalogs."""
    chunks = sorted((root / "dist" / "bundle" / "chunks").glob("*.js"))
    candidates = [p for p in chunks if "backup" not in p.name and any(m in p.read_text(encoding="utf-8", errors="replace") for m in CATALOG_MARKERS)]
    if not candidates:
        sys.exit(f"FATAL: no bundle chunk with an inlined model catalog under {root}")
    if len(candidates) > 1:
        # live chunk = the one that also holds the provider table
        live = [p for p in candidates if "var MODELS={" in p.read_text(encoding="utf-8", errors="replace")]
        candidates = live or candidates
    return max(candidates, key=lambda p: p.stat().st_size)


def keep_from_host_config() -> dict[str, str]:
    """Provider ids this host's own config depends on, with the reason."""
    keep: dict[str, str] = {}
    models_json = AGENT_DIR / "models.json"
    if models_json.exists():
        try:
            cfg = json.loads(models_json.read_text(encoding="utf-8"))
            for pid, spec in (cfg.get("providers") or {}).items():
                if not isinstance(spec, dict):
                    continue
                if spec.get("models") and not (spec.get("baseUrl") and spec.get("api")):
                    keep[pid] = "models.json: custom models inherit api/baseUrl from the built-in catalog"
                elif spec.get("modelOverrides"):
                    keep[pid] = "models.json: modelOverrides target the built-in catalog"
        except Exception as exc:  # noqa: BLE001
            log(f"  ! could not read {models_json}: {exc}")
    mm_json = AGENT_DIR / "model-manager.json"
    if mm_json.exists():
        try:
            mm = json.loads(mm_json.read_text(encoding="utf-8"))
            for prov in mm.get("providers") or []:
                if isinstance(prov, dict) and prov.get("enabled"):
                    keep.setdefault(prov["id"], "model-manager.json: enabled provider")
        except Exception as exc:  # noqa: BLE001
            log(f"  ! could not read {mm_json}: {exc}")
    for pid in STATIC_KEEP:
        keep.setdefault(pid, "static keep list")
    for pid in STATIC_KEEP_EXTRA:
        keep.setdefault(pid, "static keep list (opt-in)")
    return keep


def match_object(text: str, open_idx: int) -> int:
    """Index of the matching '}' for the '{' at open_idx (JSON-ish data only)."""
    assert text[open_idx] == "{"
    depth = 0
    i = open_idx
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in "\"'`":
            quote = ch
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == quote:
                    break
                i += 1
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("unbalanced object literal")


def plan(text: str) -> list[tuple[str, str, int, int]]:
    """[(provider_id, var_name, start, end)] for every inlined provider catalog."""
    out = []
    seen: set[tuple[str, int]] = set()
    for m in [*CALL_RE.finditer(text), *GENERIC_CALL_RE.finditer(text)]:
        var = m.group(3)
        var_decl = re.search(r'var ' + re.escape(var) + r'=', text)
        if not var_decl:
            continue
        open_idx = text.index("{", var_decl.end())
        key = (var, open_idx)
        if key in seen:
            continue
        seen.add(key)
        close_idx = match_object(text, open_idx)
        out.append((m.group(2), var, open_idx, close_idx + 1))
    return out


def backup_path(chunk: Path) -> Path:
    return chunk.with_suffix(chunk.suffix + f".backup-{time.strftime('%Y%m%d-%H%M%S')}-decat")


def revert(chunk: Path) -> None:
    backups = sorted(chunk.parent.glob("*.backup-*-decat"))
    if not backups:
        sys.exit(f"FATAL: no *-decat backup next to {chunk.name}")
    newest = backups[-1]
    shutil.copy2(newest, chunk)
    log(f"reverted {chunk.name} from {newest.name}")


def main() -> None:
    ap = argparse.ArgumentParser(description="P-6b: drop unused built-in model catalogs from the live Pi bundle")
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="pi-coding-agent package dir (default: global npm install)")
    ap.add_argument("--keep", default="", help="extra provider ids to keep, comma separated")
    ap.add_argument("--blank", default="", help="provider ids to blank even if kept by config")
    ap.add_argument("--apply", action="store_true", help="write the patch (default: dry run)")
    ap.add_argument("--revert", action="store_true", help="restore the newest -decat backup")
    args = ap.parse_args()

    chunk = find_bundle_chunk(args.root)
    log(f"chunk : {chunk}")
    text = chunk.read_text(encoding="utf-8", errors="replace")

    if args.revert:
        revert(chunk)
        return

    keep = keep_from_host_config()
    for pid in filter(None, (s.strip() for s in args.keep.split(","))):
        keep[pid] = "--keep"
    for pid in filter(None, (s.strip() for s in args.blank.split(","))):
        keep.pop(pid, None)

    entries = plan(text)
    if len(entries) < 10:
        sys.exit(f"FATAL: found only {len(entries)} provider catalogs - bundle layout changed, do not patch blindly")

    todo, kept_used = [], []
    total = 0
    for pid, var, start, end in entries:
        size = end - start
        if pid in keep:
            kept_used.append((pid, size, keep[pid]))
            continue
        if text[start:end] == "{}":
            continue
        todo.append((pid, var, start, end, size))
        total += size - 2

    log(f"providers in bundle: {len(entries)}   to blank: {len(todo)}   kept: {len(kept_used)}")
    log()
    log("kept (and why):")
    for pid, size, why in sorted(kept_used):
        log(f"  keep  {pid:26s} {size/1024:7.1f} KB  {why}")
    log()
    log(f"blanking {total/1024:.0f} KB of catalog data:")
    for pid, var, start, end, size in sorted(todo, key=lambda e: -e[4])[:12]:
        log(f"  blank {pid:26s} {size/1024:7.1f} KB")
    if len(todo) > 12:
        log(f"  ... and {len(todo)-12} more")

    if not todo:
        log("\nalready patched - nothing to do")
        return
    if not args.apply:
        log("\ndry run - re-run with --apply to write")
        return

    new = text
    for pid, var, start, end, size in sorted(todo, key=lambda e: -e[2]):
        new = new[:start] + "{}" + new[end:]

    backup = backup_path(chunk)
    shutil.copy2(chunk, backup)
    chunk.write_text(new, encoding="utf-8")
    log(f"\nbackup : {backup.name}")
    log(f"patched: {len(text)/1024:.0f} KB -> {len(new)/1024:.0f} KB (-{total/1024:.0f} KB)")
    log("verify : node --check " + str(chunk))
    log("revert : python scripts/pi_runtime_decat.py --revert")


if __name__ == "__main__":
    main()
