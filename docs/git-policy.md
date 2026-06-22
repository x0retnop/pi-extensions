# Git Policy — Local Agent Use

Git is used locally by agents for safety and small checkpoints. Nothing is pushed.

## Basic rule

Commit when a chunk of work is done. Don't leave a pile of unrelated changes uncommitted.

## Commit prefixes

Use a short prefix so history is readable:

```
[root]    AGENTS.md, README.md, package.json, tsconfig.json
[docs]    docs/
[scripts] scripts/
[<ext>]   one extension folder, e.g. [context-guard]
```

## Type-check

Run `npm run typecheck` before committing code or package changes. Markdown-only changes don't need it unless you're unsure.

## Splitting commits

If one change touches several extensions or docs, split by area when it's easy:

```bash
git add context-guard/
git commit -m "[context-guard] fix path normalization"

git add docs/
git commit -m "[docs] update extension guides"
```

If splitting is awkward, one commit with a clear message is fine.

## What not to do

- Don't push, force-push, or rebase.
- Don't commit `node_modules/` or lockfiles unless deps actually changed.
- Don't mass-rename or reformat without being asked.
- Don't create, delete, move, or archive extension folders unless asked.
