#!/usr/bin/env python3
"""Compile and run the unit test suite for Pi extensions.

Usage:
    python scripts/run-tests.py [pattern]

pattern   Optional glob passed to node --test (default: *.test.js).
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / ".tests-out"
TSC_JS = ROOT / "node_modules" / "typescript" / "bin" / "tsc"
TSC_CONFIG = ROOT / "tsconfig.test.json"


def run(cmd: list[str | Path]) -> int:
    print("$", " ".join(str(c) for c in cmd))
    return subprocess.call(cmd, cwd=ROOT)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Pi extension unit tests")
    parser.add_argument("pattern", nargs="?", default="*.test.js", help="test file glob")
    args = parser.parse_args()

    if not TSC_JS.exists():
        print("error: typescript not found; run `npm install` first", file=sys.stderr)
        return 1

    # Clean previous build.
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)

    # Compile TypeScript tests (and their imported sources) to OUT_DIR.
    rc = run(["node", TSC_JS, "-p", TSC_CONFIG])
    if rc != 0:
        print("error: test compilation failed", file=sys.stderr)
        return rc

    # Run compiled tests with Node's native runner.
    test_glob = OUT_DIR / "tests" / "unit" / args.pattern
    rc = run(["node", "--test", test_glob])
    return rc


if __name__ == "__main__":
    sys.exit(main())
