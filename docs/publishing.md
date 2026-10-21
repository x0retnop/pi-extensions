# Publishing to the public repo

The public repo (`origin`, GitHub) receives a **synthetic snapshot branch**, never `main`. `main` is private working memory and stays local; `scripts/publish_public.py` builds `refs/heads/public` from `HEAD` (minus an ignore list, with optional text rewrites), leak-scans it, and pushes it to `origin/main`.

Consequences that are easy to get wrong:

- **First publish and every re-baseline need `--fresh`.** It makes a parentless commit, so the pushed history contains no path that is excluded now — that is the only way to make an excluded doc's history disappear. A normal publish just adds one commit on top, so anything published earlier stays in the public history forever.
- **GitHub does not forget on force-push.** Re-baselining leaves the old commits unreachable from the branch but still fetchable by sha until the repo is deleted or garbage-collected. Wiping them for real means deleting and recreating the repo — do that for a first publish over a history that already carried private paths; a force-push is enough when only the file set changed.
- **The snapshot is built from `HEAD`, not the working tree.** Uncommitted edits cannot leak, and the dry-run prints a warning when publishable files differ from `HEAD` (commit first, republish).
- **Path filter is `git check-ignore` against `publish-ignore.txt`** (gitignore syntax, negation works), applied to the paths in `HEAD`. Content rewrites come from `publish-scrub.txt` (`[scope | ]literal => replacement`, fnmatch glob scope, applied on export only — the working tree keeps the exact text); leak markers and their scan come from `publish-scan.txt`. All three files are excluded from the snapshot themselves, because they name private paths.
- **Scrub a name, exclude a subject.** A document about a private project, a provider account or measured traffic cannot be fixed by rewriting a word — it goes to the ignore list. Scrub rules exist for name drops inside otherwise publishable files. A rule that matches nothing is reported as *stale* and blocks the push: that is how a reworded line gets caught instead of silently leaking.
- **Which provider/model a doc reveals is not something the scan can decide.** The scan catches host markers and credential shapes; provider-usage evidence is handled by exclusion, not by the scanner. New docs about providers, quotas or accounts go into `publish-ignore.txt` by default.
- **`--push` requires `--confirm <tree-sha>`** — the tree sha printed by the dry-run the operator reviewed. A tree that changed since the review (a new file, a new doc) does not match and nothing is pushed. While leak-scan hits exist, push is refused unless `--allow-hits`.

## Procedure

```bash
python scripts/publish_public.py                  # dry-run: file list, tree sha, leak scan
python scripts/publish_public.py --fresh          # same, for a new root commit
python scripts/publish_public.py --push --confirm <tree-sha> [--fresh] [--allow-hits]
```

1. Commit what should be published (the snapshot ignores the working tree).
2. Dry-run; put the **full file list** and **scan output** in front of the operator — the agent never approves its own list.
3. Fix what the review rejects: exclude a path, add a scrub rule, or sanitize the doc itself when the phrase is the only problem.
4. Push with the exact tree sha from step 2. `--fresh` forces the push — that is the one destructive operation in this pipeline, so the operator's approval is about that specific sha.

## Push guard

Set once per clone; without it a stray `git push` could publish the private tree:

```bash
git config --local push.default nothing
git config --local remote.origin.push refs/heads/public:refs/heads/main
```

After that, a bare `git push` can only ever send the snapshot branch to `origin/main`; pushing `main` requires typing a refspec by hand.

## Rollback

- Bad content in the snapshot: add the path to `publish-ignore.txt`, re-baseline with `--fresh`, push (force) — the path leaves the branch and its history.
- The local `public` ref is a chain of snapshots: `git log public` shows what went out and when. Deleting the ref and re-running with `--fresh` starts a new chain.
- Nothing here touches `main`; a botched publish is always recoverable locally.
