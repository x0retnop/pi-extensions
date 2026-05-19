#!/usr/bin/env python3
"""ai_helper.py — simple command gate for agent subprocesses.

Usage:
    python ai_helper.py <command>
    python ai_helper.py python C:/10x001/server_CFG/cli.py status
    python ai_helper.py pkill -f uvicorn

The script loads commands.yaml from the same directory, checks the command
against allow/block rules (with token-wise * globs), and either runs it or
prints a clear refusal for the agent.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import sys

# Try YAML, fallback to JSON if missing
try:
    import yaml
except Exception:  # pragma: no cover
    yaml = None  # type: ignore[assignment]

CONFIG_NAME = "commands.yaml"


def _config_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), CONFIG_NAME)


def load_config(path: str) -> dict:
    if not os.path.exists(path):
        return {"allow": [], "block": []}
    with open(path, "r", encoding="utf-8") as f:
        if yaml:
            return yaml.safe_load(f) or {}
        import json
        return json.load(f)


def tokenize(cmd: str) -> list[str]:
    """Split command into tokens respecting quotes (Windows-friendly)."""
    try:
        return shlex.split(cmd.strip(), posix=False)
    except ValueError:
        return cmd.strip().split()


def match_pattern(pattern: str, command: str) -> bool:
    """Token-wise glob: * matches any sequence of tokens (including empty)."""
    pat = tokenize(pattern)
    cmd = tokenize(command)
    pi = ci = 0

    while pi < len(pat) and ci < len(cmd):
        if pat[pi] == "*":
            # trailing * → matches everything left
            if pi + 1 == len(pat):
                return True
            next_p = pat[pi + 1]
            # advance cmd until next token matches next_p
            while ci < len(cmd) and cmd[ci] != next_p:
                ci += 1
            if ci == len(cmd):
                return False
            pi += 1
            # let the next loop iteration compare next_p with cmd[ci]
        else:
            if pat[pi] != cmd[ci]:
                return False
            pi += 1
            ci += 1

    # consume trailing stars
    while pi < len(pat) and pat[pi] == "*":
        pi += 1

    return pi == len(pat) and ci == len(cmd)


def decide(command: str, config: dict) -> tuple[str, str | None]:
    """Return (action, matched_pattern). action ∈ {'allow','block','deny'}."""
    for pat in config.get("block", []):
        if match_pattern(pat, command):
            return "block", pat
    for pat in config.get("allow", []):
        if match_pattern(pat, command):
            return "allow", pat
    return "deny", None


def run_allowed(command: str) -> int:
    """Execute the command via shell and stream output directly."""
    result = subprocess.run(command, shell=True, text=True)
    return result.returncode


def show_help(config: dict) -> int:
    print("=== ai_helper.py - allowed commands ===\n")
    allowed = config.get("allow", [])
    blocked = config.get("block", [])

    if allowed:
        print("Allowed:")
        for i, pat in enumerate(allowed, 1):
            print(f"  {i}. {pat}")
    else:
        print("Allowed: (none configured)")

    if blocked:
        print(f"\nBlocked patterns: {', '.join(blocked)}")

    print("\nTips:")
    print("  *  = matches any sequence of arguments (including nothing).")
    print("  Wrap the whole command in quotes if it contains spaces.")
    print("  If a command is not listed above, it will be rejected.")
    print("\nUsage: python ai_helper.py <command>")
    print('Example: python ai_helper.py "python C:/10x001/server_CFG/cli.py status"')
    return 0


def main(argv: list[str]) -> int:
    config = load_config(_config_path())

    if len(argv) < 2 or argv[1].lower() in ("help", "-h", "--help"):
        return show_help(config)

    command = ' '.join(argv[1:])
    action, matched = decide(command, config)

    if action == "block":
        print(f"Blocked by rule: {matched}")
        print("This command is explicitly forbidden. Do not attempt it.")
        return 1

    if action == "deny":
        print("Command not allowed.")
        print(f"  Command: {command}")
        print("The agent should only use pre-approved commands. Check commands.yaml.")
        return 1

    # action == "allow"
    return run_allowed(command)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
