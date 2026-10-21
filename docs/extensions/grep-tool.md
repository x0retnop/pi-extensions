# grep-tool

Project-wide `grep` tool override powered by ripgrep.

## Important behaviors

- Requires `rg` (ripgrep) in `PATH`.
- Respects `.gitignore` by default. `include_ignored: true` also searches ignored files. `.env` and `.env.*` are never searched, including an explicit `path` (rg globs do not apply to a path given on the command line).
- Git Bash `/c/...` paths are normalized to Windows drive letters.
- Content mode refuses above 100 matches, or above 50 when `-A`/`-B`/`-C` is set, including a single file. Preflight passes `--with-filename` because bare `rg -c` on one file prints only the count and the parser drops it. `allow_broad`, or a `head_limit` at or below the threshold, skips the refuse. Display still caps at 200 unless `head_limit` says otherwise.

## Rendering

- The call line is a pi-tui `Text` (wraps, never cut at the terminal edge); before `pattern` streams in
  it reads `grep ...`.
- The result body is Pi's built-in grep body, inherited by name: 15 lines collapsed, everything on
  Ctrl+O. That body prints `[Truncated: N matches limit]` from `details.matchLimitReached`, so the
  extension sets that field whenever `head_limit` caps the output — the row then says so while
  collapsed, which the extension's own `[Hint: …]` (last line of the text) can never do.
- Refusals and failures — `rg` missing, `.env`, broad-query refuse, regex error — return
  `isError: true`: error-colored row and an error flag for the model, the same shape as Pi's built-in
  grep, which rejects outright on those cases.
