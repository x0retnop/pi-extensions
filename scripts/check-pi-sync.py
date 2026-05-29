#!/usr/bin/env python3
"""Pi CLI / Extensions sync checker.

Mini-utility for the coding agent. Run this after a Pi CLI update to decide
whether local extensions need code changes.

What it does:
- Detects the installed Pi version (global npm/pnpm > local node_modules > package.json).
- Fetches the upstream CHANGELOG from the Pi mono-repo.
- Lists releases newer than your installed version.
- Scans local *.ts / *.json for known obsolete patterns (renamed packages,
  deprecated API keys, etc.).
- Flags CHANGELOG red-flag terms that may affect extensions.

Exit codes:
- 0: no issues detected (or no newer releases).
- 1: could not determine local version, or fetch failed.

Usage:
    python scripts/check-pi-sync.py
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen

CHANGELOG_URL = "https://raw.githubusercontent.com/earendil-works/pi-mono/main/packages/coding-agent/CHANGELOG.md"

# Known patterns that always mean trouble
OBSOLETE_PATTERNS = {
    "@mariozechner/": "Old package scope -- must be @earendil-works/* (changed in 0.74.0)",
    "reasoningEffortMap": "Deprecated provider key -- use thinkingLevelMap (changed in 0.72.0)",
}

# Keywords that, if seen in CHANGELOG entries above baseline, warrant attention
RED_FLAG_TERMS = [
    "Breaking Changes",
    "minimum supported Node",
    "Extension API",
    "registerProvider",
    "registerTool",
    "registerCommand",
    "message_end",
    "thinking_level_select",
    "tool rendering",
    "theme sharing",
    "jiti",
    "package scope",
    "@mariozechner",
    "reasoningEffortMap",
    "thinkingLevelMap",
    "incremental bash",
    "compact read",
    "renderShell",
]

EXCLUDED_SCAN_PATHS = {
    "node_modules",
    ".git",
    "dist",
    ".agents",
    "package-lock.json",
    ".package-lock.json",
}


def _parse_npm_json(stdout: str) -> str | None:
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return None
    deps = data.get("dependencies", {})
    pkg = deps.get("@earendil-works/pi-coding-agent")
    if isinstance(pkg, dict):
        return pkg.get("version")
    return None


def get_local_pi_version():
    # 1. Try globally installed npm/pnpm/bun package
    #    Use shutil.which so Windows finds .cmd shims (npm.CMD etc.).
    for pkg_mgr, raw_cmd in (
        ("npm", ["npm", "list", "-g", "@earendil-works/pi-coding-agent", "--depth=0", "--json"]),
        ("pnpm", ["pnpm", "list", "-g", "@earendil-works/pi-coding-agent", "--json", "--depth", "0"]),
        ("bun", ["bun", "pm", "ls", "-g", "@earendil-works/pi-coding-agent", "--json"]),
    ):
        try:
            exe = shutil.which(raw_cmd[0])
            if not exe:
                continue
            list_cmd = [exe] + raw_cmd[1:]
            cp = subprocess.run(list_cmd, capture_output=True, text=True, timeout=15)
            if cp.returncode in (0, 1):
                ver = _parse_npm_json(cp.stdout)
                if ver:
                    return ver, f"global {pkg_mgr}"
        except Exception:
            pass

    # 2. Try local node_modules (dev checkout)
    nm = Path("node_modules/@earendil-works/pi-coding-agent/package.json")
    if nm.exists():
        data = json.loads(nm.read_text(encoding="utf-8"))
        ver = data.get("version")
        if ver:
            return ver, "local node_modules"

    # 3. Fallback to root package.json peerDependencies
    root = Path("package.json")
    if root.exists():
        data = json.loads(root.read_text(encoding="utf-8"))
        peer = data.get("peerDependencies", {})
        for key in ("@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"):
            if key in peer:
                ver = peer[key]
                if ver and ver != "*":
                    return ver, "package.json peerDependencies"
    return None, None


def fetch_changelog():
    with urlopen(CHANGELOG_URL, timeout=15) as resp:
        return resp.read().decode("utf-8")


def parse_versions(changelog):
    """Return list of (version_tuple, version_str, section_text)."""
    pattern = re.compile(r"^## \[([\d.]+)\].*$", re.MULTILINE)
    matches = list(pattern.finditer(changelog))
    versions = []
    for i, m in enumerate(matches):
        ver_str = m.group(1)
        try:
            ver_tuple = tuple(int(x) for x in ver_str.split("."))
        except ValueError:
            continue
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(changelog)
        section = changelog[start:end]
        versions.append((ver_tuple, ver_str, section))
    return versions


def _should_scan_file(path: Path) -> bool:
    for part in path.parts:
        if part in EXCLUDED_SCAN_PATHS:
            return False
    if path.name in EXCLUDED_SCAN_PATHS:
        return False
    return True


def scan_local_obsoletes():
    results = {}
    base = Path(".")
    ts_files = list(base.rglob("*.ts")) + list(base.rglob("*.json"))
    ts_files = [f for f in ts_files if _should_scan_file(f)]
    for pat, desc in OBSOLETE_PATTERNS.items():
        hits = []
        for f in ts_files:
            try:
                text = f.read_text(encoding="utf-8")
                if pat in text:
                    hits.append(str(f))
            except Exception:
                continue
        if hits:
            results[pat] = {"desc": desc, "files": hits}
    return results


def rg_local(pattern):
    """Run rg if available, else fallback to simple file scan."""
    try:
        cp = subprocess.run(
            ["rg", pattern, "--type", "ts", "-l"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if cp.returncode == 0:
            return cp.stdout.strip().splitlines()
    except Exception:
        pass
    # Fallback
    hits = []
    for f in Path(".").rglob("*.ts"):
        if not _should_scan_file(f):
            continue
        try:
            if pattern in f.read_text(encoding="utf-8"):
                hits.append(str(f))
        except Exception:
            continue
    return hits


def main():
    print("=" * 60)
    print("Pi CLI / Extensions Sync Check")
    print("=" * 60)

    local_ver, local_source = get_local_pi_version()
    if not local_ver:
        print("ERROR: Could not determine local Pi version.")
        sys.exit(1)
    print(f"Installed Pi version: {local_ver}  (source: {local_source})")

    print("\nFetching CHANGELOG...")
    try:
        changelog = fetch_changelog()
    except Exception as e:
        print(f"ERROR: Failed to fetch CHANGELOG: {e}")
        sys.exit(1)

    versions = parse_versions(changelog)
    if not versions:
        print("ERROR: Could not parse CHANGELOG.")
        sys.exit(1)

    try:
        local_tuple = tuple(int(x) for x in local_ver.split("."))
    except ValueError:
        print(f"ERROR: Cannot parse local version {local_ver}")
        sys.exit(1)

    newer = [(v, s, t) for v, s, t in versions if v > local_tuple]
    if not newer:
        print("Installed version matches or exceeds latest in CHANGELOG. Nothing to do.")
        return

    print(f"\nFound {len(newer)} newer release(s) in CHANGELOG:")
    for _, s, _ in newer:
        print(f"  - {s}")

    # Check red flags in newer sections
    combined_text = "\n".join(t for _, _, t in newer)
    flags_found = []
    for term in RED_FLAG_TERMS:
        if term.lower() in combined_text.lower():
            flags_found.append(term)

    print("\n--- CHANGELOG Red Flags ---")
    if flags_found:
        for f in flags_found:
            print(f"  ! {f}")
    else:
        print("  None detected.")

    # Local obsolete patterns
    print("\n--- Local Extension Scan ---")
    obsolete = scan_local_obsoletes()
    if obsolete:
        for pat, info in obsolete.items():
            print(f"\n  OBSOLETE PATTERN: {pat}")
            print(f"  Why: {info['desc']}")
            for hf in info["files"]:
                print(f"    -> {hf}")
    else:
        print("  No known obsolete patterns found.")

    # Map red flags to local files for concrete API terms
    api_hits = {}
    for term in flags_found:
        if any(
            x in term
            for x in (
                "registerProvider",
                "registerTool",
                "registerCommand",
                "message_end",
                "thinking_level_select",
                "reasoningEffortMap",
                "thinkingLevelMap",
                "renderShell",
            )
        ):
            hits = rg_local(term)
            if hits:
                api_hits[term] = hits

    if api_hits:
        print("\n--- Red Flag → Local File Matches ---")
        for term, files in api_hits.items():
            print(f"\n  {term} found in:")
            for f in files:
                print(f"    -> {f}")
    else:
        print("\n  No local matches for CHANGELOG red flags.")

    # Summary
    print("\n" + "=" * 60)
    if flags_found or obsolete:
        print("RESULT: Attention needed. Review the matches above.")
        print("Next: run 'npx tsc --noEmit' on flagged extensions.")
    else:
        print("RESULT: No issues detected. Pi update looks safe for this collection.")
    print("=" * 60)


if __name__ == "__main__":
    main()
