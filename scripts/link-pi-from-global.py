#!/usr/bin/env python3
"""Junction this repo's @earendil-works/* onto the global Pi CLI.

Why: `npm i @earendil-works/pi-coding-agent` here pulls ~200MB of provider
SDKs via the package shrinkwrap. Typecheck and unit tests only need the
package entrypoints; the global CLI already has them. Junctions make tsc
and node resolve the same copy the runtime uses.

Do not: add @earendil-works/* to this repo's package.json, npm-install them
into an extension folder, or shutil.rmtree a junction (that can follow the
link). Recreate with `npm install` (postinstall) or this script.

Usage:
    python scripts/link-pi-from-global.py          # create / refresh
    python scripts/link-pi-from-global.py --check  # verify, print versions
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NM = REPO / "node_modules"
SCOPE = NM / "@earendil-works"
PACKAGES = ("pi-coding-agent", "pi-ai", "pi-tui")


def lexists(path: Path) -> bool:
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def is_dir_link(path: Path) -> bool:
    if not lexists(path):
        return False
    try:
        return path.is_junction() or path.is_symlink()
    except OSError:
        return False


def under_nm(path: Path) -> bool:
    try:
        path.resolve().relative_to(NM.resolve())
        return True
    except ValueError:
        return False


def npm_global_root() -> Path:
    exe = shutil.which("npm")
    if exe:
        cp = subprocess.run(
            [exe, "root", "-g"],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if cp.returncode == 0:
            root = Path(cp.stdout.strip())
            if root.is_dir():
                return root
    appdata = os.environ.get("APPDATA")
    if appdata:
        fallback = Path(appdata) / "npm" / "node_modules"
        if fallback.is_dir():
            return fallback
    raise RuntimeError(
        "cannot find npm global node_modules; is @earendil-works/pi-coding-agent installed?"
    )


def agent_pkg(global_root: Path) -> Path:
    path = global_root / "@earendil-works" / "pi-coding-agent"
    if not path.is_dir():
        raise RuntimeError(
            f"global Pi CLI not found at {path}\n"
            "install with: npm i -g @earendil-works/pi-coding-agent"
        )
    return path


def target_for(name: str, agent: Path, global_root: Path) -> Path:
    if name == "pi-coding-agent":
        return agent
    nested = agent / "node_modules" / "@earendil-works" / name
    if nested.is_dir():
        return nested
    top = global_root / "@earendil-works" / name
    if top.is_dir():
        return top
    raise RuntimeError(
        f"{name} not found under {agent / 'node_modules' / '@earendil-works'} "
        f"or {global_root / '@earendil-works'}"
    )


def pkg_version(path: Path) -> str:
    meta = path / "package.json"
    if not meta.is_file():
        return "?"
    try:
        return str(json.loads(meta.read_text(encoding="utf-8")).get("version") or "?")
    except (OSError, json.JSONDecodeError):
        return "?"


def link_dest(name: str) -> Path:
    return SCOPE / name


def same_dir(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve()
    except OSError:
        return False


def remove_local(path: Path) -> None:
    """Remove a local node_modules entry. Never follow a junction/symlink."""
    if not lexists(path):
        return
    if not under_nm(path):
        raise RuntimeError(f"refusing to delete outside node_modules: {path}")
    if is_dir_link(path):
        path.unlink()
        return
    if path.is_dir():
        shutil.rmtree(path)
        return
    path.unlink()


def make_junction(dest: Path, target: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        cp = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(dest), str(target)],
            capture_output=True,
            text=True,
        )
        if cp.returncode != 0:
            err = (cp.stderr or cp.stdout or "").strip()
            raise RuntimeError(f"mklink /J failed for {dest.name}: {err}")
        return
    dest.symlink_to(target, target_is_directory=True)


def planned_links() -> list[tuple[str, Path, Path]]:
    global_root = npm_global_root()
    agent = agent_pkg(global_root)
    out: list[tuple[str, Path, Path]] = []
    for name in PACKAGES:
        target = target_for(name, agent, global_root).resolve()
        if not target.is_dir():
            raise RuntimeError(f"target is not a directory: {target}")
        if under_nm(target):
            raise RuntimeError(f"refusing to link into this repo's node_modules: {target}")
        out.append((name, link_dest(name), target))
    return out


def ensure_links() -> int:
    rows = planned_links()
    for name, dest, target in rows:
        if is_dir_link(dest) and same_dir(dest, target):
            print(f"ok  {name} -> {target} ({pkg_version(target)})")
            continue
        remove_local(dest)
        make_junction(dest, target)
        if not same_dir(dest, target):
            raise RuntimeError(f"junction created but resolve mismatch: {dest} vs {target}")
        print(f"link {name} -> {target} ({pkg_version(target)})")
    return 0


def check_links() -> int:
    try:
        rows = planned_links()
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    rc = 0
    for name, dest, target in rows:
        ver = pkg_version(target)
        if not lexists(dest):
            print(f"missing  {name}  (want {target} {ver})", file=sys.stderr)
            rc = 1
            continue
        if not is_dir_link(dest):
            print(
                f"not-a-link  {name}  at {dest} — do not npm-install @earendil-works/* here",
                file=sys.stderr,
            )
            rc = 1
            continue
        if not same_dir(dest, target):
            print(f"wrong-target  {name}  {dest.resolve()} != {target}", file=sys.stderr)
            rc = 1
            continue
        print(f"ok  {name} {ver} -> {target}")
    return rc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify junctions exist and point at global Pi; do not create",
    )
    args = parser.parse_args()
    try:
        return check_links() if args.check else ensure_links()
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
