> ⚠️ **DEPRECATED / DISABLED**
> `permission-gate` is no longer active. It is not copied to `~/.pi/agent/extensions/` and this document is unmaintained. Do not edit or rely on it.

# Permission Gate — Agent Guide

Quick map for agents editing `permission-gate/` in a fresh session.

## Files and responsibilities

| File | What it does | You edit it when... |
|------|--------------|---------------------|
| `index.ts` | Entry point. Hooks `tool_call` (read/write/edit/bash), calls engine/path-guard, renders UI. | You change **when** a tool is intercepted or the **text of blocked/denied messages** sent to the model. |
| `engine.ts` | Decision logic. `decide()`, `decideBash()`, `fallbackNeedsAsk()`, `isSafeReadBash()`, prompt formatters. | You change **approval rules** (e.g. "allow X in yolo", "block Y always"), or **how prompts look**. |
| `path-guard.ts` | Path classification (`inside_project` / `outside_project` / `protected`), bash path heuristics. | You add/remove **protected roots**, **trusted read roots**, or fix **Git Bash / Windows path hints**. |
| `analyzer.ts` | Tokenizer + CommandDB analyzer. Turns a bash string into `AnalyzedCommand` (risk, categories, flags). | You fix **redirect logic**, **segment analysis**, or **inline script scanning**. |
| `command-db.ts` | Loads `commanddb.json`, resolves aliases/flags. | Almost never — logic is stable. |
| `commanddb.json` | The database of 190+ commands, subcommands, flags, risks. | You add a **new command**, **subcommand**, or **flag effect** (escalate/reduce). |
| `inline-scan.ts` | Scans `python -c`, `python - <<EOF`, `node -e` for risky patterns. | You add **new inline patterns** for Python or Node. |
| `tokenizer.ts` | Splits bash into pipelines, compounds, segments, redirects. | Almost never — only if tokenizer misparses a new shell construct. |
| `types.ts` | Shared TypeScript types. | You add a new **risk**, **category**, or **effect** type. |

## Bash command flow

```
Raw command string
  → tokenizer.ts   (split by | && || ;  → segments with argv + redirects)
  → analyzer.ts    (look up each segment in commanddb.json, apply flags/redirects/inline-scan)
  → engine.ts      (fallbackNeedsAsk + mode rules + session allowlist)
  → path-guard.ts  (traversal check + external/protected path hints)
  → index.ts       (block / ask / allow)
```

**Key rule:** `engine.ts` decides *risk-level*; `path-guard.ts` decides *location*.

## How to add or change a command in commanddb.json

Minimal entry example:

```json
"mycommand": {
  "aliases": ["mc"],
  "commonFlags": {
    "--help": { "effect": "none" },
    "-f": { "effect": "escalate", "toRisk": "write", "addCategories": ["write"] }
  },
  "defaultCategories": ["read"],
  "defaultRisk": "read",
  "description": "What it does",
  "subcommands": {
    "install": {
      "risk": "install",
      "categories": ["install", "network"],
      "autoAllowModes": ["yolo"]
    }
  }
}
```

- `defaultRisk` / `defaultCategories` — used when no subcommand matches.
- `subcommands` — exact token match first, then first non-flag token match.
- `commonFlags` — exact match first. For combined short flags (`-abc`) a partial match loop runs (`flag.includes(f[1])`). **Be careful:** adding a single-letter flag like `-h` can accidentally match longer flags that contain that letter.
- `autoAllowModes` — if the current mode is in this list, the segment is auto-allowed regardless of fallback logic.
- `aliases` — resolved by `command-db.ts`.

## How approval modes work

`fallbackNeedsAsk(risk, mode)` in `engine.ts` is the single source of truth for "should this risk level ask by default?".

- `strict`: everything except `read` asks.
- `balanced`/`relaxed`: `execute`, `delete`, `install`, `destructive`, `unknown` ask.
- `yolo`: only `delete`, `install`, `destructive` ask.

`autoAllowModes` on a command/subcommand can override this and allow freely in listed modes.

## YOLO safe-read outside project

`isSafeReadBash(analysis)` in `engine.ts` defines what counts as "safe read" in YOLO when the path is outside the project:

- `risk` must be `read` or `network`.
- No bad categories: `delete`, `execute`, `install`, `destructive`, `unknown`.
- No compound operators (`&&`, `||`, `;`). Pipes (`|`) are allowed if both ends are safe.
- Redirects to `/dev/null` or `nul` are ignored (they do not elevate risk to `write`).

If a command is safe-read + outside project in YOLO → `allow`.
If it is **not** safe-read + outside project in YOLO → `ask`.

## Path guard quick reference

`classifyPathAccess(targetPath, cwd)` → `{ scope, reason }`

- `inside_project` — target is under `cwd`.
- `protected` — target is inside one of `getProtectedRoots()` (e.g. `C:\Windows`, `~/.ssh`, `~/.pi`).
- `outside_project` — everything else.

`commandMentionsExternalOrProtectedPath(command)` is a fast **bash string heuristic** (not exact). It checks substrings like `c:\`, `c:/`, `/c/`, `/windows`, `.pi`, `.ssh`, etc. If a Git Bash path style is missing from the hints, add it here.

## Common tasks — where to go

| Task | File | Section/Function |
|------|------|------------------|
| Command X is unknown / wrong risk | `commanddb.json` | Add entry under `"x"` or edit `defaultRisk` / `subcommands` |
| Flag `-y` should escalate risk | `commanddb.json` | Add to `commonFlags` or subcommand `flags` |
| New inline language to scan | `inline-scan.ts` | Add extractor + pattern array |
| Allow more in YOLO | `engine.ts` | Edit `fallbackNeedsAsk()` or `isSafeReadBash()` |
| Block something harder | `engine.ts` | Add early `return { action: "block" }` in `decide()` or `decideBash()` |
| Protected root missing | `path-guard.ts` | Edit `getProtectedRoots()` |
| Trusted read root missing | `path-guard.ts` | Edit `getTrustedReadRoots()` |
| Git Bash `/d/...` not detected | `path-guard.ts` | Edit `commandMentionsExternalOrProtectedPath()` hints |
| Approval prompt looks bad | `engine.ts` | Edit `formatBashPrompt`, `formatReadPrompt`, `formatWritePrompt` |
| Write/edit denied message to model | `index.ts` | Edit the `block: true, reason: ...` return strings |

## Important gotchas

1. **CommandDB is loaded fresh every call** — `command-db.ts` no longer caches. Changes to `commanddb.json` apply immediately in the next tool call.
2. **Module cache still applies** — edits to `.ts` files require a **new Pi session** (or extension reload) to take effect.
3. **Partial flag match bug** — `resolveFlagEffect()` uses `flag.includes(f[1])` for combined short flags. A long flag like `-name` can accidentally match a short flag like `-e` (because `name` contains `e`). Prefer exact-match flags and avoid adding generic single-letter `commonFlags` to commands with many long flags.
4. **Redirects to `/dev/null` or `nul`** are stripped from write risk in `analyzer.ts`. If you add a new "null" target, add it to `isNullRedirectTarget()` there.
