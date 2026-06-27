# Handoff — pi-multi-edit Rendering & Agent UX

**Last updated:** 2026-06-13
**Extension:** `pi-multi-edit/`
**Status:** ⚠️ **OUTDATED — historical reference only.** This document describes the pre-refactor design (old `oldText`/`newText` schema, `multi[]` batches, `partialApply`, and files like `classic.ts` that no longer exist). The extension was refactored into separate `edit`, `multi_edit`, and `insert` tools using `old_string`/`new_string`. For current behavior, see `docs/extensions/pi-multi-edit.md` and the source files under `pi-multi-edit/`.

---

## What this extension does

Overrides the built-in `edit` tool with three modes:
1. **Single:** `path + oldText + newText` — one change, one file.
2. **Single-file batch:** top-level `path` + `edits: [{oldText, newText}, ...]` — many changes in ONE file. **PREFERRED for multiple edits in same file.**
3. **Multi-file batch:** `multi: [{path, oldText, newText}, ...]` — changes across DIFFERENT files.

Key feature: **Atomic batches** — if any edit fails preflight, zero files are modified. Rollback on error during actual apply.

---

## What currently WORKS ✅

### Core editing logic (`classic.ts`)
- `findActualString` with 4 match passes: exact, normalize curly quotes, trim trailing whitespace per line, and **indentation normalization** (tabs ↔ spaces auto-conversion based on detected file indent style).
- `applyClassicEdits` groups edits by file, sorts by position, applies sequentially with offset tracking.
- **Rollback on error** works: snapshots map → restore original content.
- **Preflight** (`continueOnError: true` + virtual workspace) correctly catches mismatches before writing.
- **Preflight distinct messaging** (`≈ Matched` vs `✓ Edited`) prevents agents from thinking files were mutated during preflight.
- **Skipped edits after failure in same file** are marked `⊘` with clear note: *"Fix the failed edit(s) and retry the whole batch."*

### Agent prompts (`index.ts`)
- Guidelines strongly push batching: `PREFER batching`, `NEVER send multiple separate edit calls for the same file`.
- Examples included in guidelines (JSON snippets for `edits` and `multi`).
- Preflight error message explicitly says: *"retry THE ENTIRE BATCH (do not split into separate calls)."*

---

## What is BROKEN / FRAGILE / KNOWN ISSUES ❌

### 1. Tool call header sometimes INVISIBLE (CRITICAL — partially fixed)

**Symptom:** Agent starts editing, user sees only error text (`STOP — do not rewrite...`) but NO `edit:batch path.ts (4 changes)` header above it. Looks like the error came from nowhere.

**Root cause:** Using `context.lastComponent` in `renderCall` to reuse the previous renderer instance. Pi's TUI sees the same object reference and doesn't create a new visual block — the header renders in the wrong place or is hidden by previous state.

**Fix applied:** `renderCall` now ALWAYS creates `new EditHeaderRenderer()`. `renderResult` uses `context.state.headerRenderer` (saved during `renderCall`).

**Status:** Should be fixed. Monitor for recurrence.

### 2. Body/content is EMPTY — no diff shown

**Symptom:** Tool block shows only the header line (`edit:batch src/modals.ts (4 changes)`). No diff body, no summary. User toggles Ctrl+E — still empty.

**Root cause:** `renderResult` returns `{ render() { return []; } }` (empty array). With `renderShell: "self"`, Pi expects the body to come from `renderResult`. Returning empty array = zero body lines.

**Why it's intentional:** We tried rendering diffs in `renderResult` and got severe TUI glitches (see below). The current empty-body approach is a deliberate compromise for stability.

**Tradeoff:** User sees only the header + the text result in the message stream. No inline diff. This is the "only bulletproof solution" documented in `docs/tool-rendering.md`.

### 3. TUI glitches when rendering diffs (DOCUMENTED, NOT FIXED)

From `docs/tool-rendering.md` battle-tested lessons:
- Large-file diffs (>1000 lines source) flash giant text on expand/collapse.
- Returning `[]` during `isPartial` causes height jump 0→N and flashes old buffer content.
- Manual `theme.bg()` padding causes black holes and width miscounts.
- Native built-in renderer conflict: if `renderShell: "default"` is used, built-in `edit` fallback creates duplicate blocks and JSON dumps.

**Verdict:** We accept empty `renderResult` body to avoid all of this. The diff is still available in `details.diff` and shown as plain text in the LLM result.

### 4. Agent overcautiousness after preflight fail

**Symptom:** After a preflight fail (e.g., tab vs space mismatch), agent does 3-4 `read:raw` calls in a row with tiny offsets, repeatedly verifying the same lines. Slows down workflow.

**Root cause:** The `≈ Matched` / `✗` / `⊘` output is clear, but agents still want 100% certainty before retrying the batch. They also don't always trust the "Did you mean line X" hint.

**Partial mitigation:** Guidelines now say *"use the MOST RECENT read output as the only source for oldText"*. But this is model behavior, not fixable in code.

### 5. Batch success rate ~50% (agent behavior, not code)

**Observation:** In many sessions, batch edits fail 1-2 times and agents fall back to single edits. Even though we explicitly tell them *"do NOT split into separate calls"*.

**Why it happens:**
- Agent sees 1 failure, loses confidence in the batch approach.
- Retry logic often leads to "let me be safe and do this one by one."
- Tab/whitespace mismatches are common and break batches.

**Partially addressed (2026-06-11):**
- Added `normalizeIndentOldText` fallback pass in `findActualString` that auto-converts tabs ↔ spaces using detected indent unit (2/4 spaces or tabs) and estimated tab width.
- `diagnoseMismatch` now reports exact counts: *"you sent 1 tab(s), file has 2 space(s)"*.
- `buildSuggestion` appends indent description to candidate lines.
- This should reduce tab/space mismatches from hard failures to silent corrections, but agents still need to get newText indentation right.

---

## File-by-file status

| File | Status | Notes |
|---|---|---|
| `index.ts` | ✅ Stable | Prompts updated. Rendering uses new component pattern. |
| `classic.ts` | ✅ Stable | Core logic works. `isPreflight` flag added. Indent-normalization fallback added. |
| `types.ts` | ✅ Stable | `skipped` and `preflight` flags added to `EditResult`. Patch types removed. |
| `diff.ts` | ✅ Stable | Unified diff generation. Used internally. |
| `workspace.ts` | ✅ Stable | Virtual + real workspace implementations. |

---

## Current rendering architecture

```
renderShell: "self"  (mandatory for built-in override)

renderCall:
  → new EditHeaderRenderer()  (ALWAYS fresh, no lastComponent reuse)
  → saves to context.state.headerRenderer
  → returns 1-line colored header: "edit:batch src/modals.ts (4 changes)"

renderResult:
  → if options.isPartial: return empty component []
  → lookup context.state.headerRenderer
  → change its bg: toolPendingBg → toolSuccessBg / toolErrorBg
  → return empty component []  (body is intentionally empty)
```

**Why no body:** Any non-empty body causes TUI glitches. The actual result text (diff summary, error details) is returned in `execute()` as `content: [{type: "text", text: ...}]` and rendered by Pi's message renderer, NOT the tool renderer.

---

## What to try in next session (if issues persist)

1. **Test `renderShell: "default"` with a custom tool name** (e.g., `edit2` instead of overriding built-in `edit`). This would let Pi draw the colored Box and we could return a simple body. But agents would need to learn to call `edit2`.

2. **Add tab-normalization fallback** — if exact match fails and file uses tabs but `oldText` uses spaces (or vice versa), auto-convert and retry. Risk: could cause unintended replacements.

3. **Improve fuzzy matching** — add more `MATCH_PASSES` (e.g., normalize mixed indentation, handle CRLF vs LF).

4. **Consider removing `renderCall`/`renderResult` entirely** and letting Pi fall back to native rendering. This only works if we keep the tool name `edit` AND the argument schema matches native expectations. Our `multi` param would break the native renderer → not viable.

5. **Add a simple one-line body** in `renderResult` (e.g., `+3 / -2` stats) using `options.expanded` for Ctrl+E toggle. Test heavily for glitches.

---

## Key decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-10 | `renderShell: "self"` mandatory | Built-in `edit` fallback causes duplicates/JSON dumps. |
| 2026-06-10 | Empty `renderResult` body | Any diff body causes TUI flashes/crashes on large files. |
| 2026-06-10 | `≈` vs `✓` distinction in preflight | Agents confused by `✓ Edited` when files weren't mutated. |
| 2026-06-11 | Remove `context.lastComponent` reuse | Caused invisible/missing headers for consecutive edit calls. |
| 2026-06-11 | Add batching examples to guidelines | Agents weren't using `edits`/`multi` arrays consistently. |
| 2026-06-11 | Add indent-normalization fallback pass | Tab/space mismatches are the #1 cause of batch preflight failures in agent logs. |
| 2026-06-11 | Richer indentation hints in errors | Agents can't visually distinguish 2 vs 3 spaces in backtick-quoted output; explicit counts help. |
| 2026-06-13 | Remove `patch` mode | Agents never used Codex-style patch syntax; `edits`/`multi` cover all real cases. |

---

## How to test after changes

1. Copy `pi-multi-edit/` to `~/.pi/agent/extensions/`.
2. Restart Pi.
3. Ask agent to make 3+ changes in the same file.
4. **Watch for:**
   - Header appears (`edit:batch file.ts (3 changes)`)?
   - If preflight fails, is the header still visible above the error?
   - On success, does header turn green without ghost artifacts?
   - Agent retries the ENTIRE batch, not splitting into single edits?
5. **Known acceptable:** No inline diff body. Result text appears in message stream below.
