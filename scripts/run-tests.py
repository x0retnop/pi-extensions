#!/usr/bin/env python3
"""Compile and run the unit test suite for Pi extensions.

Agent-oriented wrapper around `node --test`:
- pattern = file-name substring, path, or glob; `.ts` paths resolve to compiled `.js`;
- only *.test.js files reach the runner — .js.map and helpers are excluded;
- default output is a compact verdict: pass/fail counts, which file(s) ran,
  failing test names + source file, and a short error excerpt (full noise: -v).

Usage:
    python scripts/run-tests.py                         # all unit tests
    python scripts/run-tests.py session-memory          # substring of the file name
    python scripts/run-tests.py tests/unit/pi-session-memory.test.ts
    python scripts/run-tests.py --list                  # show available test files
    python scripts/run-tests.py -v gate                 # full node output for debugging
"""

import argparse
import fnmatch
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / ".tests-out"
TEST_SRC = ROOT / "tests" / "unit"
TEST_OUT = OUT_DIR / "tests" / "unit"
TSC_JS = ROOT / "node_modules" / "typescript" / "bin" / "tsc"
TSC_CONFIG = ROOT / "tsconfig.test.json"

DETAIL_TOKENS = ("error", "assert", "expected", "actual", "+ ", "- ")


def run(cmd: list[str | Path], *, capture: bool = False) -> tuple[int, str, str]:
    if capture:
        result = subprocess.run(
            cmd,
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return result.returncode, result.stdout, result.stderr
    return subprocess.call(cmd, cwd=ROOT), "", ""


def _copy_tree_files(src: Path, dst: Path, patterns: tuple[str, ...]) -> None:
    """Copy matching files from src tree into dst, preserving relative paths."""
    if not src.is_dir():
        return
    for pattern in patterns:
        for path in src.rglob(pattern):
            if not path.is_file():
                continue
            rel = path.relative_to(src)
            target = dst / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def _copy_test_assets() -> None:
    """Mirror non-TS assets that unit tests resolve via import.meta.url."""
    copies: list[tuple[str, str, tuple[str, ...]]] = [
        ("context-guard", "context-guard", ("*.md",)),
        ("role-sw/roles", "role-sw/roles", ("*.md",)),
        ("role-sw", "role-sw", ("SYSTEM.md",)),
        ("sub-agents", "sub-agents", ("*.md",)),
        ("sub-agents/tasks", "sub-agents/tasks", ("*.md",)),
        ("ui-theme/presets", "ui-theme/presets", ("*.json",)),
    ]
    for src_rel, dst_rel, patterns in copies:
        _copy_tree_files(ROOT / src_rel, OUT_DIR / dst_rel, patterns)


def list_source_tests() -> list[str]:
    return sorted(p.stem for p in TEST_SRC.glob("*.test.ts"))


def normalize_pattern(pattern: str) -> str:
    """Accept a path, stem, or glob; return a compiled-filename needle.

    Agents pass tests/unit/foo.test.ts or absolute paths; compiled files
    are foo.test.js under .tests-out. Directories are stripped and .ts
    is rewritten to .js so both forms match.
    """
    p = (pattern or "").strip().strip("\"'")
    if not p:
        return ""
    if "/" in p or "\\" in p:
        p = Path(p).name
    if p.lower().endswith(".ts"):
        p = p[:-3] + ".js"
    return p


def match_source_tests(pattern: str) -> list[str]:
    """Same matching rules as find_compiled_tests, against tests/unit/*.test.ts stems."""
    names = list_source_tests()
    needle = normalize_pattern(pattern)
    if not needle or needle in ("*", "*.test.js"):
        return names
    if any(ch in needle for ch in "*?["):
        return [
            n
            for n in names
            if fnmatch.fnmatch(n + ".js", needle) or fnmatch.fnmatch(n, needle)
        ]
    low = needle.lower()
    return [n for n in names if low in n.lower() or low in (n + ".js").lower()]


def find_compiled_tests(pattern: str) -> list[Path]:
    """Resolve a user pattern to compiled .test.js files.

    Plain text matches as a case-insensitive substring of the file name;
    glob magic (* ? [) is treated as a real glob. Only *.test.js files are
    returned, so sourcemaps never reach `node --test` as fake test files.
    """
    all_tests = sorted(TEST_OUT.glob("*.test.js"))
    needle = normalize_pattern(pattern)
    if not needle or needle in ("*", "*.test.js"):
        return all_tests
    if any(ch in needle for ch in "*?["):
        return [p for p in all_tests if fnmatch.fnmatch(p.name, needle)]
    low = needle.lower()
    return [p for p in all_tests if low in p.name.lower()]


def source_label(loc: str) -> str:
    """Map a node 'test at compiled.js:line:col' location back to tests/unit/*.test.ts."""
    path = re.sub(r":\d+:\d+$", "", loc.strip())
    name = Path(path).name
    if name.endswith(".test.js"):
        return f"tests/unit/{name[:-3]}.ts"
    return name


def _file_note(files: list[Path]) -> str:
    n = len(files)
    if n == 1:
        return files[0].stem
    if 1 < n <= 5:
        return f"{n} files: " + ", ".join(p.stem for p in files)
    return f"{n} file(s)"


_NAME_RE = re.compile(r"^(✔|✖)\s+(.*?)\s*(?:\(\d+(?:\.\d+)?ms\))?\s*$")
_STAT_RE = re.compile(r"^ℹ\s+(tests|pass|fail|skipped|cancelled|todo|duration_ms)\s+(\S+)\s*$")
_LOC_RE = re.compile(r"^test at (.+)$")


def parse_spec_output(output: str):
    """Extract pass/fail test names, failure details, locations, and stats.

    Only column-0 ✔/✖ markers are tests; indented lines are subtests or
    failure details. Names are deduped (node re-lists failures at the end),
    keeping the entry with the most detail lines. `test at PATH:line:col`
    immediately before a ✖ is recorded as that test's location.
    """
    passed: list[str] = []
    failed: dict[str, list[str]] = {}
    failed_at: dict[str, str] = {}
    stats: dict[str, str] = {}
    pending_loc: str | None = None
    lines = output.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        loc_m = _LOC_RE.match(line.strip())
        if loc_m:
            pending_loc = loc_m.group(1).strip()
            i += 1
            continue
        m = _NAME_RE.match(line)
        if m:
            name = m.group(2).strip()
            if name == "failing tests:":
                # node's summary section header, not a test name.
                i += 1
                continue
            if m.group(1) == "✔":
                passed.append(name)
                pending_loc = None
                i += 1
                continue
            detail: list[str] = []
            j = i + 1
            while j < len(lines) and (not lines[j].strip() or lines[j][0] in " \t"):
                detail.append(lines[j])
                j += 1
            if len(detail) > len(failed.get(name, [])):
                failed[name] = detail
                if pending_loc:
                    failed_at[name] = pending_loc
            pending_loc = None
            i = j
            continue
        sm = _STAT_RE.match(line.strip())
        if sm:
            stats[sm.group(1)] = sm.group(2)
        i += 1
    return passed, failed, stats, failed_at


def pick_excerpt(detail: list[str], limit: int = 6) -> list[str]:
    """Keep the informative lines of a failure block (assertion, expected/actual)."""
    chosen = [
        d
        for d in detail
        if any(t in d.lower() for t in DETAIL_TOKENS) and not d.strip().startswith("code:")
    ]
    if not chosen:
        chosen = [d for d in detail if d.strip()]
    return [d.strip() for d in chosen[:limit]]


def report(rc: int, output: str, files: list[Path]) -> int:
    passed, failed, stats, failed_at = parse_spec_output(output)
    total = stats.get("tests", str(len(passed) + len(failed)))
    n_pass = stats.get("pass", str(len(passed)))
    n_fail = stats.get("fail", str(len(failed)))
    note = _file_note(files)

    if rc == 0 and not failed:
        duration = stats.get("duration_ms", "?")
        seconds = round(float(duration) / 1000, 1) if duration != "?" else "?"
        skipped = int(stats.get("skipped", "0"))
        skip_note = f", {skipped} skipped (intentional)" if skipped else ""
        print(f"PASS: {n_pass} tests ok{skip_note} ({note}, {seconds}s)")
        return 0

    if not failed:
        # Runner crashed outside any test — no structured info; show the tail.
        print(f"FAIL: node --test exited {rc} without reporting test results ({note}):")
        for line in output.splitlines()[-30:]:
            print(f"  {line}")
        return 1

    print(f"FAIL: {n_fail}/{total} tests failed ({note}):")
    for name, detail in failed.items():
        loc = failed_at.get(name)
        where = f"  ({source_label(loc)})" if loc else ""
        print(f"  ✖ {name}{where}")
        for line in pick_excerpt(detail):
            print(f"      {line}")
    print("Rerun with -v for full node output.")
    return 1


def print_no_match(pattern: str) -> None:
    resolved = normalize_pattern(pattern)
    print(f"error: no test files match {pattern!r}", file=sys.stderr)
    if resolved and resolved != pattern:
        print(f"       resolved to filename {resolved!r}", file=sys.stderr)
    raw = Path(pattern)
    candidate = raw if raw.is_absolute() else (ROOT / pattern)
    try:
        exists = candidate.is_file()
    except OSError:
        exists = False
    if exists and ".test." not in candidate.name:
        print(
            f"       {candidate.name} is source, not a unit test — "
            "use a tests/unit/*.test.ts name (or omit the pattern)",
            file=sys.stderr,
        )
    print("available:", file=sys.stderr)
    for name in list_source_tests():
        print(f"  {name}", file=sys.stderr)
    print("hint: substring or path;  python scripts/run-tests.py --list", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run Pi extension unit tests (agent-friendly wrapper)",
    )
    parser.add_argument(
        "pattern",
        nargs="?",
        default="",
        help="file-name substring or path (tests/unit/foo.test.ts); default: all",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="show full node --test output"
    )
    parser.add_argument(
        "--list", action="store_true", help="list available test files and exit"
    )
    args = parser.parse_args()

    if args.list:
        for name in list_source_tests():
            print(name)
        return 0

    if args.pattern and not match_source_tests(args.pattern):
        print_no_match(args.pattern)
        return 1

    if not TSC_JS.exists():
        print("error: typescript not found; run `npm install` first", file=sys.stderr)
        return 1

    pi_types = ROOT / "node_modules" / "@earendil-works" / "pi-coding-agent"
    if not pi_types.exists():
        print(
            "error: Pi types not linked; run `npm install` "
            "or `python scripts/link-pi-from-global.py`",
            file=sys.stderr,
        )
        return 1

    # Clean previous build.
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)

    # Compile TypeScript tests (and their imported sources) to OUT_DIR.
    rc, tsc_stdout, tsc_stderr = run(
        ["node", TSC_JS, "-p", TSC_CONFIG], capture=not args.verbose
    )
    if rc != 0:
        print("error: test compilation failed", file=sys.stderr)
        if not args.verbose:
            print(tsc_stdout, file=sys.stderr)
            print(tsc_stderr, file=sys.stderr)
        return rc

    # Copy non-TS runtime assets that modules resolve via import.meta.url
    # (roles, agent defs, context-notice prompts). Without this, loaders
    # look next to the compiled .js under .tests-out and find nothing.
    _copy_test_assets()

    candidates = find_compiled_tests(args.pattern)
    if not candidates:
        print_no_match(args.pattern)
        return 1

    node_cmd = ["node", "--test", *[str(p) for p in candidates]]
    if args.verbose:
        rc, _, _ = run(node_cmd)
        return rc

    rc, stdout, stderr = run(node_cmd, capture=True)
    return report(rc, stdout + "\n" + stderr, candidates)


if __name__ == "__main__":
    sys.exit(main())
