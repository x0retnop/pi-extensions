# pi-multi-edit R&D log for Kimi K2.x

> Tracking the gap between Kimi K2.6/K2.7 Code training, the Kimi Code CLI harness, and the Pi `pi-multi-edit` extension.  
> Use this file to record design decisions, implementation status, and real-session observations.

---

## 1. Goal

Build a Pi file-editing extension that is as close as possible to the **editing vocabulary Kimi K2.x was actually trained on**, while keeping it safe and observable inside Pi.  The extension should:

- replace Pi's built-in `edit` tool;
- expose `edit` (single replacement) as the primary primitive;
- expose `multi_edit` as an **experimental** batch primitive to see whether K2.7 uses it in practice;
- preserve BOM/CRLF/LF and avoid the corruption bugs seen in Kimi Code CLI;
- give the model clear guidelines so it knows which tool to pick.

---

## 2. What the model was trained on

From the Kimi K2.6 Hugging Face model card and SWE-agent-style ACI:

```yaml
commands:
  view:        read file or directory
  createfile:  create/overwrite file with full content
  strreplace:  replace exact old string with new string
  insert:      insert text at a specific line
  bash:        execute shell command
  submit:      mark task complete
```

Key semantics:

- `strreplace`: `path`, `old_string`, `new_string`.  `old_string` expected to appear exactly once.
- `insert`: `path`, `insert_line`, `new_string`.
- `createfile`: `path`, `file_text`.

Kimi K2.7 Code is a coding fine-tune of K2.6.  Its strongest coding behavior is likely aligned with this minimal vocabulary, **not** with the richer `list[Edit]` batch shape that Kimi Code CLI added later.

---

## 3. How Kimi Code CLI differs from training

Kimi Code CLI is informative but **not authoritative** for the model's training distribution:

| Training concept | CLI tool | Difference |
|---|---|---|
| `strreplace` | `StrReplaceFile` | CLI accepts `Edit \| list[Edit]`; training likely used single edits |
| `createfile` | `WriteFile` | same idea, different name |
| `insert` | `StrReplaceFile` insert mode | not a separate tool in CLI |
| `view` | `ReadFile` | same idea, different name |
| `bash` | `Shell` | same idea, different name |

CLI issues to avoid:

- CRLF/LF corruption (#1952) → preserve line endings explicitly.
- `difflib` blocking the event loop (#1607/#1659) → guard large diff computation.
- Edit failures / loops (#2443, #1570, #646) → preflight before writing, clear errors.
- Tool-call ID mismatch (`functions.{name}:{idx}` vs bare UUIDs, #128) → Pi handles this, but worth watching.

---

## 4. Design decisions taken

### 4.1 `edit` = single replacement

Schema:

```json
{
  "path": "src/app.py",
  "old_string": "exact text",
  "new_string": "replacement",
  "replace_all": false
}
```

Why:

- matches `strreplace` from training;
- matches Anthropic `str_replace_editor` and Claude Code `Edit`;
- simpler schema → fewer hallucinated parameters;
- `replace_all` is a boolean, normalizing the CLI/Claude behavior.

### 4.2 `multi_edit` = optional batch (experiment)

Schema:

```json
{
  "path": "src/app.py",
  "edits": [
    {"old_string": "a", "new_string": "b"},
    {"old_string": "c", "new_string": "d"}
  ]
}
```

Why keep it:

- the user wants to observe whether K2.7 uses batch edits when given a clear choice;
- some edits are genuinely sequential (edit #2 depends on edit #1);
- removing batches entirely would make the experiment one-sided.

Guidelines emphasize: prefer `edit` for one change, use `multi_edit` only for several independent replacements in the same file.

### 4.3 `insert` tool (planned)

Schema:

```json
{
  "path": "src/app.py",
  "insert_line": 42,
  "new_string": "    new_line();"
}
```

Why:

- `insert` is part of the model's native training vocabulary;
- using `edit` to insert lines forces the model to craft an `old_string` that overlaps a line boundary, which is error-prone;
- a dedicated tool is closer to SWE-agent/Anthropic behavior.

### 4.4 BOM / CRLF / LF preservation

Implementation stores original BOM and dominant line ending, normalizes to LF for matching, then restores on write.  This directly addresses Kimi CLI #1952.

### 4.5 Preflight before write

Every edit runs against a virtual workspace first.  If preflight fails, no real file is modified.  This avoids the partial-write/rollback problems of Kimi CLI's sequential loop.

### 4.6 Fuzzy match fallback with transparency

If exact match fails, the engine tries normalized match (smart quotes → ASCII, trailing whitespace trimmed, Unicode spaces collapsed).  The result reports success but flags that the match was fuzzy, so the model can learn to copy verbatim next time.

---

## 5. Current implementation status

| Component | Status | Notes |
|---|---|---|
| `edit` single replacement | implemented | `old_string`/`new_string`/`replace_all` |
| `multi_edit` batch | implemented | atomic, sequential, preflight |
| `insert` tool | planned | line-based insertion |
| BOM/CRLF preservation | implemented | `normalize.ts` |
| Virtual preflight | implemented | `workspace.ts` |
| Fuzzy match | implemented | `match.ts`, needs transparency in messages |
| Line-number hints in errors | planned | helps model self-correct |
| Parallel-call guideline | planned | tell model to use parallel `edit` for different files |
| Error rendering | needs fix | currently shows "failed" instead of message |
| `multi_edit` error path | needs fix | `buildMultiError` is dead code because engine throws early |

---

## 6. Hypotheses to validate in real sessions

1. **Single-edit preference.**  K2.7 will choose `edit` for >80% of file changes, even when `multi_edit` is available.
2. **Batch usage pattern.**  When `multi_edit` is used, it will be for small, non-overlapping edits in the same file; sequential dependency will be rare.
3. **Insert adoption.**  If `insert` is available, the model will use it for line additions instead of awkward `edit` calls.
4. **Fuzzy match frequency.**  Fuzzy fallback will trigger occasionally on quote/whitespace mismatches; surfacing it will reduce recurrence.
5. **Parallel calls.**  When multiple files need changes, K2.7 can emit parallel `edit` calls if the guideline is explicit.
6. **Error recovery.**  Clear line-number hints will reduce retry loops on mismatch.

---

## 7. Observability plan

To validate the hypotheses we need data from real sessions.  The following can be extracted from `~/.pi/agent/sessions/*.jsonl` or from custom logging inside the extension:

| Metric | How to measure |
|---|---|
| Tool choice distribution | Count `edit` vs `multi_edit` vs `insert` calls per session |
| `multi_edit` batch size | `edits.length` histogram |
| `multi_edit` success rate | fraction of batches fully/partially succeeding |
| Fuzzy match rate | count replacements where `usedFuzzy === true` |
| Retry after mismatch | count sequential `edit` calls to the same file after failure |
| Parallelism | count turns with >1 `edit` call to different files |
| CRLF/BOM corruption | compare before/after hashes for files with non-LF endings |
| Event-loop blocking | watch for timeout errors on large files (>10k lines) |

Useful follow-up tools:

- `scripts/pi_session_inspect.py` for call/error counts;
- a small post-session notebook that parses `tool_call` entries for `edit`/`multi_edit`/`insert`.

---

## 8. Known gaps and next steps

### 8.1 Immediate (before real-world testing)

- [x] Fix `multi_edit` error handling so `buildMultiError` is actually reachable.
- [x] Fix `renderResult` to show the real error message instead of `"failed"`.
- [x] Add guideline encouraging parallel `edit` calls for different files.
- [x] Surface fuzzy-match flag in success messages.
- [x] Add line-number hints to "not found" / "duplicate" errors.
- [x] Implement `insert` tool.
- [x] Run `npm run typecheck` and `python scripts/run-tests.py` after changes.

### 8.2 After first real sessions

- [ ] Review session logs: did K2.7 use `multi_edit`?  Under what conditions?
- [ ] Measure fuzzy-match rate and decide whether to keep, tighten, or make it stricter.
- [ ] Decide whether `insert` reduces line-boundary edit failures.
- [ ] If single-edit + parallel calls dominates, consider deprecating or demoting `multi_edit`.
- [ ] If `multi_edit` is heavily used for independent edits, consider adding `partialApply` mode.

### 8.3 Open questions

- Does Pi serialize tool-call IDs in a format K2.7 recognizes?  (Training expects `functions.{name}:{idx}`.)
- Does Pi carry `reasoning_content` across multi-turn loops for Kimi provider?  (Assumed yes.)
- How does K2.7 behave when `multi_edit` and `insert` are both present alongside `edit`?  Does choice overload hurt?

---

## 9. References

- `docs/model-context/kimi-k2/index.md`
- `docs/model-context/kimi-k2/known-issues.md`
- `docs/model-context/kimi-k2/pi-runtime-notes.md`
- `docs/model-context/kimi-k2/tool-comparison.md`
- `docs/extensions/pi-multi-edit.md`
- `pi-multi-edit/index.ts`
