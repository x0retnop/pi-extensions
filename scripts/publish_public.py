#!/usr/bin/env python3
"""Build the filtered `public` snapshot branch and push it only on confirmation.

Why: the working tree is a private agent harness. Docs about other local
projects, session telemetry tooling and personal billing notes must never reach
the public repo, while everything else in `main` should. The public branch is a
synthetic snapshot built from `HEAD` minus `publish-ignore.txt`, rewritten by
`publish-scrub.txt`, scanned by `publish-scan.txt`, and pushed as
`refs/heads/public` -> `origin/main`. `main` itself is never pushed.

Hard rules (see `docs/publishing.md`):
  - the first publish (or any re-baseline) uses `--fresh`: a new root commit,
    so the public history never contains a path that is excluded now;
  - `--push` requires `--confirm <tree-sha>` printed by the dry-run, i.e. the
    operator approved that exact tree;
  - `publish-ignore.txt`, `publish-scrub.txt` and `publish-scan.txt` name
    private paths, so they stay out of the snapshot.

Do not: edit the `public` branch by hand, `git push` this repo directly, or
move paths between `main` and the snapshot in any other way.

Usage:
    python scripts/publish_public.py                  # dry-run: list, tree sha, scan
    python scripts/publish_public.py --fresh          # dry-run of a new root commit
    python scripts/publish_public.py --quiet-files    # summary only
    python scripts/publish_public.py --push --confirm <tree-sha> [--fresh] [--allow-hits]
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
IGNORE = REPO / "publish-ignore.txt"
SCRUB = REPO / "publish-scrub.txt"
SCAN = REPO / "publish-scan.txt"

PUBLIC_REF = "refs/heads/public"
REMOTE = "origin"
REMOTE_BRANCH = "main"

# Credential shapes. Kept in the script (generic) — host-specific markers live
# in publish-scan.txt so that the script itself is publishable.
SECRET_PATTERNS = [
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), "api key literal"),
    (re.compile(r"\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"), "github token"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "aws key id"),
    (re.compile(r"\bxox[bap]-[A-Za-z0-9-]{10,}"), "slack token"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY"), "private key"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), "jwt"),
    (re.compile(r"Bearer [A-Za-z0-9._-]{24,}"), "bearer token"),
]


def git(args: list[str], *, input_bytes: bytes | None = None, env: dict | None = None,
        check: bool = True) -> subprocess.CompletedProcess:
    res = subprocess.run(["git", *args], cwd=REPO, input=input_bytes, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and res.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed:\n{res.stderr.decode('utf-8', 'replace').strip()}")
    return res


def nul_split(raw: bytes) -> list[str]:
    return [p.decode("utf-8", "surrogateescape") for p in raw.split(b"\0") if p]


def read_rules(path: Path, sep: str | None = None) -> list:
    """Non-comment, non-blank lines; split on `sep` when given."""
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line.split(sep, 1) if sep else line)
    return out


def head_names() -> list[str]:
    """Every path in HEAD — the snapshot is always the last commit, never the
    working tree, so uncommitted edits cannot leak."""
    return [record.partition("\t")[2]
            for record in nul_split(git(["ls-tree", "-r", "-z", "HEAD"]).stdout)]


def excluded_files(paths: list[str]) -> set[str]:
    """Paths matched by publish-ignore.txt (gitignore syntax, negation works)."""
    if not IGNORE.exists():
        sys.exit(f"missing {IGNORE.name}")
    res = git(["-c", f"core.excludesFile={IGNORE}", "check-ignore", "--no-index", "-z", "--stdin"],
              input_bytes=("\0".join(paths) + "\0").encode("utf-8", "surrogateescape"),
              check=False)
    return set(nul_split(res.stdout))


def head_blobs() -> dict[str, tuple[str, str]]:
    """path -> (mode, blob sha) for every blob in HEAD."""
    entries = {}
    for record in nul_split(git(["ls-tree", "-r", "-z", "HEAD"]).stdout):
        meta, _, path = record.partition("\t")
        parts = meta.split()
        if len(parts) == 3 and parts[1] == "blob":
            entries[path] = (parts[0], parts[2])
    return entries


def scrub_rules() -> list[tuple[str, str, str]]:
    """`[scope | ]literal => replacement` records; scope is fnmatch globs, comma-separated."""
    rules = []
    for line in read_rules(SCRUB):
        head, _, replacement = line.partition("=>")
        if not replacement:
            sys.exit(f"{SCRUB.name}: expected `[scope | ]literal => replacement`, got: {line}")
        scope = "*"
        if "|" in head:
            scope, head = head.split("|", 1)
            scope = scope.strip()
        rules.append((scope, head.strip(), replacement.strip()))
    return rules


def scope_matches(scope: str, path: str) -> bool:
    return any(fnmatch.fnmatch(path, pattern.strip()) for pattern in scope.split(","))


def collect(paths: list[str]) -> tuple[list[tuple[str, str, str, str]], list[tuple[str, str, str]]]:
    """(items, stale rules) — item = (path, mode, blob sha, final text), text already scrubbed."""
    blobs = head_blobs()
    rules = scrub_rules()
    used = set()
    items = []
    for path in paths:
        if path not in blobs:
            sys.exit(f"{path} is tracked but missing from HEAD — commit first")
        mode, sha = blobs[path]
        original = git(["cat-file", "blob", sha]).stdout.decode("utf-8", "surrogateescape")
        text = original
        for index, (scope, literal, replacement) in enumerate(rules):
            if not scope_matches(scope, path) or literal not in text:
                continue
            used.add(index)
            text = text.replace(literal, replacement)
        if text != original:
            sha = git(["hash-object", "-w", "--stdin"],
                      input_bytes=text.encode("utf-8", "surrogateescape")).stdout.decode().strip()
        items.append((path, mode, sha, text))
    stale = [rule for index, rule in enumerate(rules) if index not in used]
    return items, stale


def build_tree(items: list[tuple[str, str, str, str]]) -> str:
    tmp = tempfile.mkdtemp(prefix="pi-publish-")
    env = dict(os.environ, GIT_INDEX_FILE=str(Path(tmp) / "index"))
    git(["read-tree", "--empty"], env=env)
    records = [f"{mode} {sha}\t{path}\0".encode("utf-8", "surrogateescape")
               for path, mode, sha, _ in items]
    git(["update-index", "-z", "--add", "--index-info"], input_bytes=b"".join(records), env=env)
    return git(["write-tree"], env=env).stdout.decode().strip()


def scan(items: list[tuple[str, str, str, str]]) -> list[str]:
    """Scan the text that will actually be published (post-scrub)."""
    markers = read_rules(SCAN)
    hits = []
    for path, _, _, text in items:
        for i, line in enumerate(text.splitlines(), 1):
            for marker in markers:
                if marker in line:
                    hits.append(f"  marker {marker!r:24} {path}:{i}")
            for pattern, label in SECRET_PATTERNS:
                if pattern.search(line):
                    hits.append(f"  secret {label:24} {path}:{i}")
    return hits


def summarize(paths: list[str], excluded: set[str]) -> None:
    groups: dict[str, int] = {}
    for path in paths:
        top = path.split("/")[0] if "/" in path else "(root)"
        groups[top] = groups.get(top, 0) + 1
    print(f"public files: {len(paths)}   excluded: {len(excluded)}")
    for top, count in sorted(groups.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {count:4}  {top}/")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fresh", action="store_true", help="new root commit (first publish / re-baseline); push is forced")
    ap.add_argument("--push", action="store_true", help="push the snapshot to origin/main after confirmation")
    ap.add_argument("--confirm", metavar="TREE_SHA", help="tree sha printed by the dry-run the operator approved")
    ap.add_argument("--allow-hits", action="store_true", help="push even though the leak scan reported hits")
    ap.add_argument("--allow-stale", action="store_true", help="push even though some scrub rules matched nothing")
    ap.add_argument("--quiet-files", action="store_true", help="print group summary only")
    args = ap.parse_args()

    if args.push and not args.confirm:
        sys.exit("--push requires --confirm <tree-sha> (the tree the operator reviewed)")

    all_paths = head_names()
    excluded = excluded_files(all_paths)
    # the pipeline's own config names private paths — never publish it
    excluded |= {IGNORE.name, SCRUB.name, SCAN.name}
    paths = [p for p in all_paths if p not in excluded]

    items, stale = collect(paths)
    tree = build_tree(items)
    rewritten = sum(1 for path, _, sha, _ in items if sha != head_blobs()[path][1])
    hits = scan(items)
    dirty = [p for p in paths if git(["diff", "--quiet", "HEAD", "--", p], check=False).returncode != 0]

    summarize(paths, excluded | (set(all_paths) - set(paths)))
    print(f"tree: {tree}" + (f"   scrubbed: {rewritten} file(s)" if rewritten else ""))
    if dirty:
        print(f"note: {len(dirty)} publishable file(s) differ from HEAD — the snapshot is the last commit, commit first:")
        for path in dirty[:10]:
            print(f"  {path}")
    if not args.quiet_files:
        print("\n-- files going public --")
        for path in paths:
            print(f"  {path}")
    if hits:
        print(f"\n!! leak scan: {len(hits)} hit(s) — decide per hit: exclude, scrub, or accept")
        for hit in hits:
            print(hit)
    else:
        print("\nleak scan: clean")
    if stale:
        print(f"\n!! {len(stale)} stale scrub rule(s) — matched nothing, the source text probably changed:")
        for scope, literal, _ in stale:
            print(f"  {scope} | {literal[:90]}")

    parent = None
    if not args.fresh:
        res = git(["rev-parse", "--verify", "-q", PUBLIC_REF], check=False)
        if res.returncode != 0:
            sys.exit(f"\n{PUBLIC_REF} does not exist yet — the first publish needs --fresh")
        parent = res.stdout.decode().strip()

    message = f"[publish] public snapshot: {len(paths)} files" + (" (fresh baseline)" if args.fresh else "")
    commit_args = ["commit-tree", tree, "-m", message]
    if parent:
        commit_args += ["-p", parent]
    commit = git(commit_args).stdout.decode().strip()
    print(f"commit: {commit}" + (f"  (parent {parent[:8]})" if parent else "  (root)"))

    if not args.push:
        print("\ndry-run: nothing pushed. Review the list, then:")
        print(f"  python scripts/publish_public.py --push --confirm {tree}" + (" --fresh" if args.fresh else ""))
        return

    if args.confirm != tree:
        sys.exit(f"--confirm {args.confirm} does not match the tree built now ({tree}); re-run the dry-run")
    if hits and not args.allow_hits:
        sys.exit(f"{len(hits)} leak-scan hit(s) — fix them, or pass --allow-hits after deciding per hit")
    if stale and not args.allow_stale:
        sys.exit(f"{len(stale)} stale scrub rule(s) — fix the rule or pass --allow-stale")

    push_args = ["push", f"{commit}:refs/heads/{REMOTE_BRANCH}", REMOTE] if not args.fresh else \
                ["push", "--force", f"{commit}:refs/heads/{REMOTE_BRANCH}", REMOTE]
    previous_tip = git(["rev-parse", "--verify", "-q", f"refs/remotes/{REMOTE}/{REMOTE_BRANCH}"],
                       check=False).stdout.decode().strip()
    print(f"pushing {commit[:8]} -> {REMOTE}/{REMOTE_BRANCH}" + (" (forced)" if args.fresh else ""))
    git(push_args)
    git(["update-ref", PUBLIC_REF, commit])
    if previous_tip:
        print(f"previous remote tip was {previous_tip[:8]} — it stays reachable by that sha on GitHub "
              f"until the repo is cleaned; re-baselining again with --fresh does not remove it")
    print("done")


if __name__ == "__main__":
    main()
