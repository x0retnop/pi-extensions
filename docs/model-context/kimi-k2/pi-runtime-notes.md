# Pi runtime built-in edit/write tools — notes for extension design

> Source: `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/`  
> Pi version: 0.79.0 (2026-06-08).  
> Goal: understand what Pi already provides so we can build an extension that is close to the model's training without reinventing the wrong parts.

---

## 1. Built-in `edit` tool

### Schema (`edit.d.ts`)

```ts
const editSchema = Type.Object({
  path: Type.TString,
  edits: Type.TArray(Type.Object({
    oldText: Type.TString,
    newText: Type.TString,
  })),
});
```

- Only `path` + `edits[]`. No `replace_all`, no single-edit shorthand at the schema level.
- `prepareEditArguments` converts legacy single-edit `{oldText, newText}` into `edits:[{...}]`.
- It also parses `edits` if the model sends it as a JSON string (seen with Opus 4.6, GLM-5.1).

### Behavior (`edit.js` + `edit-diff.js`)

1. Resolves path relative to `cwd`.
2. Uses a per-file mutation queue (`withFileMutationQueue`) so concurrent edits to the same file are serialized.
3. Reads file as `Buffer`, converts to UTF-8 string.
4. Strips BOM, detects line ending, normalizes to LF for matching.
5. Applies **all** `edits` against the same original content, in **reverse order** by match index.
6. Rejects overlapping edits.
7. Enforces uniqueness of each `oldText` (via fuzzy-normalized count).
8. Supports **fuzzy matching**: if exact match fails, strips trailing whitespace, normalizes smart quotes/dashes/Unicode spaces, then retries.
9. Restores original line endings, prepends BOM, writes back.
10. Returns a diff + unified patch.

### Prompt text

```
Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.
```

Guidelines:
- Use edit for precise changes.
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[].
- Each edits[].oldText is matched against the original file, not after earlier edits are applied.
- Keep edits[].oldText as small as possible while still being unique.

### Key observation for K2.7 Code

The built-in Pi `edit` is **already a batch-edit tool**.  It actively tells the model to batch multiple changes into one `edits[]` call.  This is the opposite of the SWE-agent / Anthropic `str_replace_editor` pattern the model was trained on, which is single `old_string` → `new_string`.

This likely contributes to the observed behavior: K2.7 Code in Pi is hesitant about batches and falls back to single edits.

---

## 2. Built-in `write` tool

### Schema (`write.d.ts`)

```ts
const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});
```

### Behavior (`write.js`)

1. Resolves path relative to `cwd`.
2. Creates parent directories recursively.
3. Overwrites file with UTF-8 content.
4. No BOM/line-ending handling — writes exactly what the model sends.

### Prompt text

```
Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.
```

Guideline: "Use write only for new files or complete rewrites."

### Assessment for K2.7 Code

`write` is already the right primitive for full-file writes.  It matches `createfile` from the model's training vocabulary.  No change needed except maybe making the description slightly more explicit about when to use it vs. `edit`.

---

## 3. Reusable utilities in Pi runtime

`edit-diff.js` exports helpers that any extension can use or copy:

| Function | Purpose |
|---|---|
| `detectLineEnding(content)` | Returns `"\n"` or `"\r\n"` |
| `normalizeToLF(text)` | CRLF/CR → LF |
| `restoreLineEndings(text, ending)` | LF → original ending |
| `stripBom(content)` | Returns `{bom, text}` |
| `normalizeForFuzzyMatch(text)` | Strip trailing whitespace, normalize smart quotes/dashes/spaces |
| `fuzzyFindText(content, oldText)` | Exact then fuzzy find |
| `applyEditsToNormalizedContent(content, edits, path)` | Apply multiple edits with overlap/duplicate checks |
| `generateDiffString(old, new)` | Display diff with line numbers |
| `generateUnifiedPatch(path, old, new)` | Standard unified patch |
| `computeEditsDiff(path, edits, cwd)` | Preview diff without writing |

These are well-tested and handle the CRLF/BOM/encoding edge cases that Kimi Code CLI has bugs with.

---

## 4. Design options for a K2.7-aligned Pi extension

### Option A: Replace built-in `edit` with a single-replacement tool

New schema:

```ts
Type.Object({
  path: Type.String(),
  old_string: Type.String({ description: "Exact text to replace. Must be unique in the file unless replace_all is true." }),
  new_string: Type.String({ description: "Replacement text." }),
  replace_all: Type.Optional(Type.Boolean({ default: false })),
});
```

Pros:
- Matches `strreplace` from K2.6 training.
- Matches Kimi Code CLI's `Edit` and Anthropic's `str_replace_editor`.
- Simpler for the model; fewer parameters to hallucinate.

Cons:
- Multiple edits in one file require multiple tool calls. But Pi's system can encourage parallel calls.
- Loses atomic batching. However, per-file mutation queue still serializes, and edits are usually small.

### Option B: Keep batch `edits[]` but rename/normalize to CLI shape

Schema closer to Kimi Code CLI:

```ts
Type.Object({
  path: Type.String(),
  edit: Type.Union([
    Type.Object({ old: Type.String(), new: Type.String(), replace_all: Type.Optional(Type.Boolean()) }),
    Type.Array(Type.Object({ old: Type.String(), new: Type.String(), replace_all: Type.Optional(Type.Boolean()) })),
  ]),
});
```

Pros:
- Matches official Kimi Code CLI tool shape.
- Keeps batching.

Cons:
- The CLI itself may have added batches as a convenience not present in training.
- More complex schema; model may underuse batches anyway.

### Option C: Expose both `edit` (single) and `multi_edit` (batch)

Let the model choose.  But giving the model a choice it does not use well increases cognitive load and can lead to the wrong tool being picked.

### Recommendation

Start with **Option A** for an experiment:
- Replace built-in `edit` with a single-replacement `edit` tool using `old_string`/`new_string`/`replace_all`.
- Keep `write` as-is.
- Update prompt guidelines to encourage parallel `edit` calls for multiple independent changes.
- Reuse Pi's `edit-diff.js` helpers for line-ending/BOM preservation and diff generation.
- Measure: tool-call count, retry rate, task success rate.

If the experiment shows that batching is genuinely needed, add it back as a separate tool or as an optional `edits` array.

---

## 5. What we should not reuse from built-in `edit`

- The **prompt guideline that pushes `edits[]` batching**.  This contradicts the model's likely training.
- The **fuzzy match fallback** may still be useful, but it should be transparent in error messages so the model understands when it is being corrected.

---

## 6. Open questions

- How does Pi serialize tool-call IDs in the message history?  K2.7 Code expects `functions.{name}:{idx}` style from its training.
- Does Pi carry `reasoning_content` through multi-turn loops for the Kimi provider?  (Assumed yes, but worth confirming.)
- Can a Pi extension override the built-in `edit` tool cleanly without breaking the native renderer?  `pi-multi-edit` already does this with `renderShell: "self"`.
