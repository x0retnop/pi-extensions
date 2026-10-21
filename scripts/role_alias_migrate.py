#!/usr/bin/env python3
"""One-shot migration: rewrite stored role names to family aliases.

`role-sw` resolves `<family>-v<N>` role files through the alias `<family>` and
always picks the newest version (see docs/extensions/role-sw.md). Settings and
session entries written by older builds carry concrete versions
(`agent-core-v3`); they still resolve, but this script rewrites them to the
alias so the config is self-explanatory and future bumps change nothing.

Rewritten slots in ~/.pi/agent/settings.json:
  roleSwitcher.fixedRole
  roleSwitcher.modelRoleMap.<model>
  subAgents.defaultRole
  subAgents.agentOverrides.<agent>.role

Sub-agent roles are plain names by convention (`sub-default`), so those slots
normally report "already aliases" and are left as they are. The script is
idempotent and always backs up before writing (atomic replace, same directory).

Usage:
  python scripts/role_alias_migrate.py             # dry run: report only
  python scripts/role_alias_migrate.py --apply     # backup + write
  python scripts/role_alias_migrate.py --settings PATH --roles-dir PATH

Exit codes: 0 ok (even when there is nothing to write), 1 missing settings file,
2 unreadable/invalid settings JSON.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Callable, NamedTuple

VERSIONED = re.compile(r"^(.+)-v(\d+)$", re.IGNORECASE)
SELECTABLE_MD = re.compile(r"^[^_].*\.md$", re.IGNORECASE)

HOME = Path.home()
DEFAULT_SETTINGS = HOME / ".pi" / "agent" / "settings.json"
DEFAULT_ROLES_DIR = HOME / ".pi" / "agent" / "extensions" / "role-sw" / "roles"


def normalize(name: str) -> str:
    """`agent-core-v3.md` -> `agent-core`; plain names pass through."""
    clean = name.strip()
    if clean.lower().endswith(".md"):
        clean = clean[:-3]
    m = VERSIONED.match(clean)
    return m.group(1) if m else clean


def role_stems(roles_dir: Path) -> list[str]:
    try:
        return sorted(f.name[:-3] for f in roles_dir.iterdir() if f.is_file() and SELECTABLE_MD.match(f.name))
    except OSError:
        return []


def resolve_role(stems: list[str], name: str) -> str | None:
    """Mirror of role-sw's resolver: exact plain file, else newest family version."""
    clean = name.strip()
    if clean.lower().endswith(".md"):
        clean = clean[:-3]
    if not clean:
        return None
    alias = normalize(clean)
    if alias == clean and clean in stems:
        return clean
    best: str | None = None
    best_version = -1
    for stem in stems:
        m = VERSIONED.match(stem)
        if not m or m.group(1).lower() != alias.lower():
            continue
        version = int(m.group(2))
        if version > best_version or (version == best_version and best is not None and stem > best):
            best_version = version
            best = stem
    return best


class Change(NamedTuple):
    label: str
    old: str
    new: str
    setter: Callable[[str], None]


def collect(settings: dict) -> list[Change]:
    """Every role-name slot in settings, with a setter that writes the new value in place.

    Setters close over the parent container: model keys contain dots
    (`provider::model-id`), so path-string navigation would corrupt them.
    """
    out: list[Change] = []

    role_switcher = settings.get("roleSwitcher")
    if isinstance(role_switcher, dict):
        fixed = role_switcher.get("fixedRole")
        if isinstance(fixed, str) and fixed:
            out.append(
                Change(
                    "roleSwitcher.fixedRole",
                    fixed,
                    normalize(fixed),
                    lambda value, s=role_switcher: s.__setitem__("fixedRole", value),
                )
            )
        mapping = role_switcher.get("modelRoleMap")
        if isinstance(mapping, dict):
            for key, value in mapping.items():
                if isinstance(value, str) and value:
                    out.append(
                        Change(
                            f"roleSwitcher.modelRoleMap[{key}]",
                            value,
                            normalize(value),
                            lambda v, m=mapping, k=key: m.__setitem__(k, v),
                        )
                    )

    sub_agents = settings.get("subAgents")
    if isinstance(sub_agents, dict):
        default_role = sub_agents.get("defaultRole")
        if isinstance(default_role, str) and default_role:
            out.append(
                Change(
                    "subAgents.defaultRole",
                    default_role,
                    normalize(default_role),
                    lambda value, s=sub_agents: s.__setitem__("defaultRole", value),
                )
            )
        overrides = sub_agents.get("agentOverrides")
        if isinstance(overrides, dict):
            for agent, override in overrides.items():
                if isinstance(override, dict) and isinstance(override.get("role"), str) and override["role"]:
                    out.append(
                        Change(
                            f"subAgents.agentOverrides[{agent}].role",
                            override["role"],
                            normalize(override["role"]),
                            lambda v, o=override: o.__setitem__("role", v),
                        )
                    )

    return out


def stray_versioned_names(settings: dict, known_paths: set[str]) -> list[tuple[str, str]]:
    """Any other string in settings that looks like a versioned role name."""
    found: list[tuple[str, str]] = []

    def walk(node, path: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{path}.{key}" if path else str(key))
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f"{path}[{i}]")
        elif isinstance(node, str) and VERSIONED.match(node.strip()):
            if path not in known_paths:
                found.append((path, node))

    walk(settings, "")
    return found


def walker_path(label: str) -> str:
    """`roleSwitcher.modelRoleMap[KEY]` -> the path the stray walker reports."""
    return label.replace("[", ".").replace("]", "")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--settings", type=Path, default=DEFAULT_SETTINGS)
    parser.add_argument("--roles-dir", type=Path, default=DEFAULT_ROLES_DIR)
    parser.add_argument("--apply", action="store_true", help="backup and write the settings file")
    args = parser.parse_args()

    if not args.settings.is_file():
        print(f"ERROR: settings file not found: {args.settings}", file=sys.stderr)
        return 1

    try:
        settings = json.loads(args.settings.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        print(f"ERROR: cannot read settings: {err}", file=sys.stderr)
        return 2
    if not isinstance(settings, dict):
        print("ERROR: settings root is not an object", file=sys.stderr)
        return 2

    stems = role_stems(args.roles_dir)
    families = sorted({normalize(s) for s in stems})

    print(f"settings : {args.settings}")
    print(f"roles dir: {args.roles_dir}")
    print(f"roles    : {', '.join(f'{f} -> {resolve_role(stems, f)}' for f in families) or '(none)'}")
    print()

    changes = collect(settings)
    changed = [c for c in changes if c.old != c.new]
    missing = [(c.label, c.new) for c in changes if resolve_role(stems, c.new) is None]

    if changed:
        print("rewrite:")
        for change in changed:
            print(f"  {change.label}\n    {change.old}  ->  {change.new}")
    else:
        print("rewrite: nothing to do (all role names are already aliases)")

    unchanged = [c for c in changes if c.old == c.new]
    if unchanged:
        print("\nalready aliases:")
        for change in unchanged:
            print(f"  {change.label} = {change.new}")

    if missing:
        print("\nWARNING: these names do not resolve to a file in the roles dir:")
        for label, new in missing:
            print(f"  {label} -> {new}")
        print("  role-sw will keep the previous role and warn at runtime.")

    strays = stray_versioned_names(settings, {walker_path(c.label) for c in changes})
    if strays:
        print("\nNOTE: other versioned-looking strings (not role slots, left untouched):")
        for path, value in strays:
            print(f"  {path} = {value}")

    if not args.apply:
        print("\ndry run — rerun with --apply to write")
        return 0

    if not changed:
        print("\nnothing to write")
        return 0

    for change in changed:
        change.setter(change.new)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = args.settings.with_name(f"{args.settings.name}.bak-{stamp}")
    shutil.copy2(args.settings, backup)

    # Atomic replace: a crash mid-write must not leave settings.json truncated.
    tmp = args.settings.with_name(f"{args.settings.name}.tmp-{stamp}")
    tmp.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, args.settings)

    print(f"\nbackup: {backup}")
    print(f"wrote : {args.settings} ({len(changed)} change(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
