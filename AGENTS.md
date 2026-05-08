# Project AGENTS.md

## Priority and defaults

- Follow the user's current chat instructions first.
- If a local `AGENTS.md` exists, treat it as the project-specific override.
- If documentation conflicts with actual code, configs, or project structure, trust the current project state.
- Use Russian by default.
- Start with the practical result or the shortest useful path.
- Do useful work first; explain only what helps understanding, choice, or risk control.
- Keep progress updates and final reports brief.
- Do not narrate routine actions, command-by-command steps, tool usage, or internal implementation details.
- Assume the user can see terminal output, diffs, changed files, and tool calls.
- For small fixes, the final reply can be only `done`, `fixed`, or one short sentence.
- For larger changes, report only what changed in behavior/UI/script/program, what was verified, and any unchecked risk that matters.

## Autonomy and judgment

- Act without confirmation when the action is project-local, reversible, low-risk, and directly advances the requested task.
- Fix obvious adjacent issues immediately when they are small, local, low-risk, and connected to the task: typos, broken references, minor bugs, small inconsistencies, or rough edges.
- Do not turn adjacent fixes into broad cleanup, refactoring, redesign, style normalization, dependency changes, or architecture changes.
- Do not automatically agree with the user's approach.
- If a better practical path clearly reduces risk, saves time, simplifies the work, or improves the result, briefly suggest it.
- Do not overrule the user's goal or change scope without a strong practical reason.
- Prefer a narrow best-effort assumption over stopping for minor ambiguity.
- Ask only when the choice can affect behavior, public API, data format, architecture, dependencies, scope, user data, or non-local side effects.

## Scope and edits

- Work only inside the current project folder unless explicitly allowed otherwise.
- Use the smallest useful context: targeted search, small reads, focused edits.
- Do not pull unrelated files, previous chats, or external materials into context without a practical need.
- Use external docs only when project files are insufficient.
- Do not send private user or project data to external services without permission.
- If the user asks to analyze, explain, compare, review, or plan, do not edit files automatically.
- If the user asks to investigate, debug, fix, implement, improve, or make something work, focused edits are allowed.
- Prefer small, understandable changes over broad rewrites.
- Prefer precise edits over rewriting whole files.

## Verification and safety

- After edits, run the smallest meaningful local verification when practical.
- Targeted, fast, non-mutating checks are allowed for touched files or directly affected behavior.
- For TypeScript, prefer no-emit checks or existing targeted check scripts.
- For Python, prefer syntax checks for touched files unless a targeted test is clearly more useful.
- Do not run full test suites, production builds, formatters that rewrite files, generators, migrations, servers, watchers, installs, or commits unless explicitly requested.
- Do not install, update, remove, or change dependencies without permission.
- Do not use Git commands other than read-only inspection without permission.
- Do not create side effects outside the project folder without permission.
- Do not run broad scripts when scope or side effects are unclear.
- Never perform destructive actions without explicit permission: mass delete, format, reset, clean, force checkout, or broad filesystem changes.
- If an action may be unsafe, first reduce risk by narrowing scope or using read-only inspection. If risk remains, ask.

## Environment and commands

- Assume normal Windows 10 with CMD or PowerShell.
- Do not assume WSL, Git Bash, macOS, Linux, POSIX shell, or Unix utilities unless explicitly requested.
- Use the shell mainly as a launcher for `rg`, `python`, `git`, `npm`, `npx`, `pnpm`, `yarn`, or project-local tools.
- `rg` works and is the default tool for search and file discovery.
- Python 3 is available globally and is preferred for targeted reads, edits, replacement counts, generated text, and lightweight validation.
- Avoid bash-only commands or syntax unless explicitly requested: `sed`, `grep`, `awk`, `wc`, `find -printf`, heredoc `<<'PY'`, process substitution, or `for f in ...; do ...`.
- Prefer Windows-friendly commands and Python over shell pipelines when quoting, encoding, paths, or multi-line text matter.
- Use UTF-8 without BOM for code, config, Markdown, text, and agent files.
- Prefer LF line endings and forward slashes in examples. Do not normalize unrelated files.
- Do not mix shell syntaxes in one command.

Useful low-noise commands:

```text
rg -n "pattern" .
rg -n -C 3 "pattern" .
rg -l "pattern" .
rg --files -g "*.ts" -g "*.tsx" -g "*.py"
git status --short
git diff --stat
git diff -- path/to/file
npx --no-install tsc --noEmit
npx tsc --noEmit
python -m py_compile path/to/file.py
```

For short inline Python, `python -c "..."` is OK.

For multi-line Python in PowerShell, use this form:

```powershell
@'
from pathlib import Path

p = Path("src/main.ts")
print(p)
'@ | python -
```

For multi-file edits, generated text, Markdown/JSON/code output, nested quoting, or scripts longer than about 20 lines, create `_temp.py`, run it, fix if needed, then delete it.
Do not keep rewriting long inline commands after quoting/syntax errors; switch to a temporary script.

## Safety extensions

- `permission-gate` may run in relaxed mode: read-only inspection, package metadata lookup, and safe-looking inline Python reads are usually allowed.
- `protected-paths` may run in relaxed mode: ordinary external reads can be allowed, but writes/edits outside the project and sensitive roots still need caution.
- These relaxed rules reduce prompt friction; they do not permit broad scope creep. Stay project-local unless external reads are directly useful for the task.
- Installs, dependency changes, destructive commands, migrations, broad formatters, production builds, servers/watchers, and non-local writes still require explicit user permission.
