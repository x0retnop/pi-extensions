#!/usr/bin/env python3
"""Compile the whole extension tree to plain ESM .js under _build/extensions.

Why (measured 2026-09-20, scripts/ext_load_bench.py, identical registries):
Pi loads every extension through its own jiti instance with moduleCache:false,
so each .ts module boundary costs ~12 ms at startup (babel TS transform) while
the same file as .js costs ~0.9 ms. A shared common/ cannot dedupe that - the
cache is per extension. Compiling the tree: 1747 ms -> ~152 ms for 17 extensions.

The runtime copy must contain ONLY the compiled output:
  * no .ts        - Pi prefers index.ts over index.js, the source would win;
  * no package.json - with "type":"module" jiti tries Node's native ESM import
    first, fails to resolve typebox/@earendil-works (no node_modules in the
    runtime) and falls back to its own transform: 809 ms instead of 152 ms.
Assets (.md, .art, presets, roles) are copied next to the .js files.

Incremental, three levels:
  1. no source and no asset change -> nothing runs (~0.1 s);
  2. only assets changed           -> no tsc, copy what differs;
  3. .ts changed                   -> tsc --incremental re-emits the changed
     files and their dependents only, then assets are synced.
The up-to-date check is a stamp of file size + mtime_ns over every source, every
asset, tsconfig.build.json and this script itself. `--force` bypasses it.

Usage (repo root):
    python scripts/build-extensions.py            # build (skips when up to date)
    python scripts/build-extensions.py --force    # always run tsc
    python scripts/build-extensions.py --check    # build to _scratch, write nothing
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "_build"
OUT = BUILD / "extensions"
STAMP = BUILD / ".build-stamp.json"
CONFIG = ROOT / "tsconfig.build.json"
CHECK_OUT = ROOT / "_scratch" / "build-check" / "extensions"

# Mirrors "exclude" in tsconfig.build.json.
EXCLUDED_DIRS = {"node_modules", "_build", "_scratch", "Inactive", "_archive", "scripts", "tests", "docs", "mcps"}
SKIP_ASSET_NAMES = {"package.json"}
STAMP_SCHEMA = 3


def extension_dirs() -> list[Path]:
    """Flat folder layout: one folder = one extension (index.ts), plus common/."""
    dirs = []
    for d in sorted(ROOT.iterdir()):
        if not d.is_dir() or d.name in EXCLUDED_DIRS or d.name.startswith((".", "_")):
            continue
        if (d / "index.ts").is_file():
            dirs.append(d)
    common = ROOT / "common"
    if common.is_dir():
        dirs.append(common)
    return dirs


def is_excluded(rel: Path) -> bool:
    return any(part in EXCLUDED_DIRS or part.startswith(".") for part in rel.parts)


def fingerprint(p: Path) -> list[int]:
    st = p.stat()
    return [st.st_size, st.st_mtime_ns]


def collect_sources() -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for p in ROOT.rglob("*.ts"):
        rel = p.relative_to(ROOT)
        if is_excluded(rel):
            continue
        out[rel.as_posix()] = fingerprint(p)
    return out


def is_asset(p: Path, rel: Path) -> bool:
    return not p.is_dir() and not is_excluded(rel) and p.suffix != ".ts" and p.name not in SKIP_ASSET_NAMES


def collect_assets(folders: list[Path]) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for folder in folders:
        for p in folder.rglob("*"):
            if is_asset(p, p.relative_to(ROOT)):
                out[p.relative_to(ROOT).as_posix()] = fingerprint(p)
    return out


def flatten_assets(folders: list[Path]) -> list[Path]:
    files: list[Path] = []
    for folder in folders:
        for p in folder.rglob("*"):
            if is_asset(p, p.relative_to(ROOT)):
                files.append(p)
    return files


def missing_outputs(sources: dict[str, list[int]]) -> list[str]:
    return sorted(rel for rel in sources if not (OUT / rel).with_suffix(".js").is_file())


def run_tsc(out_override: Path | None = None) -> tuple[int, int, str]:
    """tsc with the repo config. out_override redirects emit (used by --check)."""
    npx = "npx.cmd" if os.name == "nt" else "npx"
    cmd = [npx, "tsc", "-p", CONFIG.name]
    if out_override is not None:
        cmd += [
            "--outDir",
            str(out_override),
            "--tsBuildInfoFile",
            str(out_override.parent / ".tsbuildinfo"),
        ]
    t0 = time.perf_counter()
    proc = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return proc.returncode, int((time.perf_counter() - t0) * 1000), (proc.stdout or "") + (proc.stderr or "")


def sync_assets(sources: dict[str, list[int]]) -> tuple[int, int, int, list[str]]:
    """Copy new/changed assets next to the .js, drop orphan .js and stale assets."""
    copied = removed_assets = orphans = 0
    warnings: list[str] = []

    for p in flatten_assets(extension_dirs()):
        rel = p.relative_to(ROOT)
        dst = OUT / rel
        if not dst.is_file() or fingerprint(dst) != fingerprint(p):
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst)
            copied += 1

    expected_js = {rel[:-3] + ".js" for rel in sources}
    for p in OUT.rglob("*.js"):
        if p.relative_to(OUT).as_posix() not in expected_js:
            p.unlink()
            orphans += 1

    keep_assets = {rel for rel in collect_assets(extension_dirs())}
    for p in OUT.rglob("*"):
        if not p.is_file() or p.suffix == ".js":
            continue
        if p.relative_to(OUT).as_posix() not in keep_assets:
            p.unlink()
            removed_assets += 1

    for folder in extension_dirs():
        if folder.name != "common" and not (OUT / folder.name / "index.js").is_file():
            warnings.append(f"no index.js emitted for {folder.name}")

    return copied, removed_assets, orphans, warnings


def count_js(root: Path) -> tuple[int, int]:
    files = lines = 0
    for p in root.rglob("*.js"):
        files += 1
        try:
            lines += len(p.read_text(encoding="utf-8", errors="replace").splitlines())
        except OSError:
            pass
    return files, lines


def report(folders: list[Path], sources: dict[str, list[int]], assets: dict[str, list[int]],
           target: Path, tsc_ms: int | None, changed: int, copied: int, removed: int, orphans: int) -> None:
    files, lines = count_js(target)
    print(f"build-extensions  {time.strftime('%Y-%m-%dT%H:%M:%S')}")
    print(f"target  {target}")
    if tsc_ms is None:
        print("tsc     skipped (no .ts change)")
    else:
        print(f"tsc     {tsc_ms} ms  incremental=on changed_sources={changed}")
    print()
    print(f"{'ext':<20}{'js':>4}{'assets':>8}")
    print("-" * 32)
    for folder in folders:
        ext_dir = target / folder.name
        n = len(list(ext_dir.rglob("*.js"))) if ext_dir.is_dir() else 0
        a = sum(1 for rel in assets if rel.startswith(folder.name + "/"))
        print(f"{folder.name:<20}{n:>4}{a:>8}")
    print("-" * 32)
    print(f"{len(folders)} folders, {files} js files, {lines} lines, {len(sources)} sources, "
          f"{copied} assets copied, {removed} stale assets removed, {orphans} orphan js removed")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="run tsc even if the stamp says up to date")
    ap.add_argument("--check", action="store_true", help="build to _scratch, write nothing in _build/")
    args = ap.parse_args()

    folders = extension_dirs()
    if not folders:
        print("no extension folders found", file=sys.stderr)
        return 1

    sources = collect_sources()
    assets = collect_assets(folders)
    script_hash = hashlib.sha1(Path(__file__).read_bytes()).hexdigest()[:12]
    cfg_fp = fingerprint(CONFIG)

    if args.check:
        if CHECK_OUT.exists():
            shutil.rmtree(CHECK_OUT)
        CHECK_OUT.mkdir(parents=True, exist_ok=True)
        code, ms, log = run_tsc(CHECK_OUT)
        if code != 0:
            sys.stderr.write(log)
            print(f"tsc failed (exit {code})", file=sys.stderr)
            return 1
        for p in flatten_assets(folders):
            dst = CHECK_OUT / p.relative_to(ROOT)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst)
        report(folders, sources, assets, CHECK_OUT, ms, len(sources), len(flatten_assets(folders)), 0, 0)
        return 0

    prev = {}
    try:
        prev = json.loads(STAMP.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass

    ts_dirty = (
        args.force
        or prev.get("schema") != STAMP_SCHEMA
        or prev.get("script") != script_hash
        or prev.get("config") != cfg_fp
        or prev.get("sources") != sources
        or bool(missing_outputs(sources))
    )
    assets_dirty = prev.get("assets") != assets

    if not ts_dirty and not assets_dirty:
        print(f"build-extensions  {time.strftime('%Y-%m-%dT%H:%M:%S')}")
        print(f"target  {OUT}")
        print(f"up to date - nothing run (built {prev.get('builtAt', '?')})")
        print(f"{len(sources)} sources, {count_js(OUT)[0]} js files, {len(assets)} assets")
        return 0

    OUT.mkdir(parents=True, exist_ok=True)

    tsc_ms: int | None = None
    if ts_dirty:
        changed = sum(1 for rel, fp in sources.items() if prev.get("sources", {}).get(rel) != fp)
        code, tsc_ms, log = run_tsc()
        if code != 0:
            sys.stderr.write(log)
            print(f"tsc failed (exit {code}) - runtime untouched", file=sys.stderr)
            return 1
    else:
        changed = 0

    copied, removed, orphans, warnings = sync_assets(sources)
    report(folders, sources, assets, OUT, tsc_ms, changed, copied, removed, orphans)

    STAMP.write_text(
        json.dumps(
            {
                "schema": STAMP_SCHEMA,
                "script": script_hash,
                "config": cfg_fp,
                "sources": sources,
                "assets": assets,
                "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    if warnings:
        print()
        for w in warnings:
            print(f"  WARN {w}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
