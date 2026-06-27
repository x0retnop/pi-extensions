# Known Kimi K2.x / Kimi Code CLI issues relevant to Pi tool design

This document collects concrete failure modes from Kimi Code CLI's issue tracker and from K2.x behavior discussions.  The goal is to avoid building the same failure modes into Pi extensions.

---

## 1. Multi-turn tool-call loops can silently terminate

**Issue:** MoonshotAI/Kimi-K2#128  
**Symptom:** K2.6 deterministically emits an empty `<|im_end|>` after the reasoning block on multi-turn followups.  
**Root cause:** `tool_call.id` format.  The model was trained on IDs shaped like `functions.{func_name}:{idx}`.  If the harness uses a different shape (e.g. bare UUIDs like `call_0004`), the model gets confused and may stop generating tool calls.

**Implication for Pi:** Ensure tool-call IDs sent in conversation history follow a consistent, model-friendly format.  Pi already exposes tools via its own layer; verify how IDs are serialized in `messages`.

---

## 2. Edit tool keeps failing / getting stuck

**Issues:** MoonshotAI/kimi-cli#2443, #1570, #646  
**Symptoms:** `StrReplaceFile` fails repeatedly or hangs.  
**Known causes:**
- CRLF/LF corruption (#1952) — `read_text()` with universal newlines converts `\r\n` to `\n`, then write converts back differently, causing full-file diffs.
- Event-loop blocking during diff generation (#1607/#1659) — `difflib.SequenceMatcher` is O(n²) and was run synchronously.
- Model using incorrect parameters (e.g. `view_range` with `str_replace`) — Hugging Face discussion #35.

**Implication for Pi:**
- Preserve original line endings, BOM, and encoding on read/write.
- Offload heavy diff computation or skip it for large files.
- Keep the edit schema simple so the model is less likely to mix parameters.

---

## 3. CRLF files get corrupted by read/edit/write

**Issue:** MoonshotAI/kimi-cli#1952  
**Fix:** PR #2362 added `newline=""` to reads, detected dominant newline style, normalized to `\n` for matching, then restored original style on write.  
**Implication for Pi:** The proposed simple `edit` tool must also preserve line endings.  Do not let Python or Node normalize newlines transparently.

---

## 4. Repeated reads of the same file

**Issues:** MoonshotAI/kimi-cli#640, #1950  
**Symptom:** After context compaction, the agent re-reads the same file in a loop.  
**Cause:** Cache-hit reference messages returned to background agents that cannot resolve parent-session references.

**Implication for Pi:** Be careful with "file unchanged since last read" optimizations.  If a tool returns a reference instead of content, the model may loop.  Always return actual content or a clear error.

---

## 5. Agent loops on the same shell command

**Issue:** MoonshotAI/kimi-cli#2142  
**Symptom:** The model issues the same `Shell` command repeatedly without new useful information.  
**Implication for Pi:** Add client-side repeated-call detection and inject a prompt reminder after several identical calls.

---

## 6. Large content causes JSON parse errors

**Discussion:** MoonshotAI/kimi-cli#963  
**Symptom:** Tool-call arguments with large content (e.g. 200+ line files) get truncated, causing `Unterminated string` parse errors.  
**Implication for Pi:** Discourage the model from putting large file contents directly into tool-call arguments.  Use `write` for large files and keep `edit` replacements small.

---

## 7. Tool descriptions matter more than expected

**Observation from OpenHands/Anthropic comparison:** The same model behaves differently depending on the exact tool description.  Vague descriptions cause the model to call the wrong tool or invent non-existent parameters.

**Implication for Pi:** Tool `description` and parameter `description` fields should be literal, short, and contain usage hints.  Avoid abstract wording.

---

## 8. `replace_all` boolean type confusion

**Issue:** anthropics/claude-code#31379  
**Symptom:** The Edit tool rejects `replace_all` when the model passes it as a string instead of boolean.  
**Implication for Pi:** Ensure the schema exposes `replace_all` as a boolean and the prompt/description reinforces this.  Alternatively, accept only literal `true`/`false` and normalize in `prepareArguments`.

---

## 9. Summary of design safeguards

| Safeguard | Why |
|---|---|
| Preserve line endings/BOM/encoding | Avoid CRLF corruption |
| Small `old_string` replacements | Reduce stale-match risk |
| Single edit per tool call | Match model training |
| Parallel calls for multiple edits | Match CLI guidance |
| Literal tool descriptions | Reduce wrong-tool calls |
| Clear errors with line-number hints | Help model self-correct |
| Detect repeated identical calls | Break loops early |
| Reasonable content size limits | Avoid JSON truncation |
