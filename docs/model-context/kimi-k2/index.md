# Kimi K2.6 / K2.7 Code — context for Pi extension design

> Last researched: 2026-06-27  
> Model used in Pi: `kimi-code-2.7` (K2.7 Code), a coding-focused fine-tune of Kimi K2.6.  
> Goal: adapt Pi's editing tools to match the patterns this model was actually trained on.
> Generalized (model-facing, non-Pi) version of this research: `C:/10x001/prompts_dev/docs/kimi-k2.7-code/TOOL_DESIGN.md`.

---

## 1. Model lineage and what it was trained on

- **Kimi K2.6** is a 1T-parameter MoE model (≈32B active per token) with a 256K context window.
- **Kimi K2.7 Code** is a coding-specialized fine-tune of K2.6, not a new architecture.
- K2.6's coding/agentic benchmark scores come from an **in-house SWE-agent-derived framework**.
- That framework exposes a minimal tool set (from the K2.6 Hugging Face model card):
  - `bash` — shell execution
  - `createfile` — create/overwrite a file
  - `insert` — insert text at a line
  - `view` — read a file or directory
  - `strreplace` — exact string replacement
  - `submit` — task completion sentinel

This is the native vocabulary the model learned for file editing.  Any Pi tool that deviates heavily from this shape is an extra translation layer the model must perform at inference time.

---

## 2. Tool-calling format

Kimi K2.x supports two provider-facing styles:

1. **OpenAI-style `tool_calls`**:
   ```json
   {
     "finish_reason": "tool_calls",
     "message": {
       "tool_calls": [{
         "id": "functions.get_weather:0",
         "function": { "name": "...", "arguments": "..." }
       }]
     }
   }
   ```

2. **Manual parsing with special tokens** (used by local/vLLM/SGLang deployments):
   ```
   <|tool_calls_section_begin|>
   <|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city":"Beijing"}<|tool_call_end|>
   <|tool_calls_section_end|>
   ```

Critical detail for multi-turn loops: K2.7 Code forces `preserve_thinking`.  The `reasoning_content` from every assistant message must be carried forward in history.  If Pi strips it, subsequent turns break.

---

## 3. Kimi Code CLI vs. the model's training

Kimi Code CLI is the official Moonshot harness.  Its tool shapes are informative, but **not identical** to the SWE-agent training vocabulary:

| Concept in training | Kimi Code CLI tool | Notes |
|---|---|---|
| `view` | `ReadFile` | different name, same idea |
| `createfile` | `WriteFile` (overwrite) | same idea |
| `strreplace` | `StrReplaceFile` | **important difference**: CLI accepts `Edit \| list[Edit]`, i.e. batch edits in one call |
| `insert` | `StrReplaceFile` insert mode | not exposed as a separate tool in the CLI layer |
| `bash` | `Shell` | same idea |

### 3.1 What Kimi Code CLI's `StrReplaceFile` actually does

From `src/kimi_cli/tools/file/replace.py`:

```python
class Edit(BaseModel):
    old: str
    new: str
    replace_all: bool = False

class Params(BaseModel):
    path: str
    edit: Edit | list[Edit]

# Apply all edits sequentially
for edit in edits:
    content = self._apply_edit(content, edit)
```

- It does **not** require `old` to be unique unless the caller wants it to be.
- It does **not** preflight.
- It does **not** roll back on failure part-way through a batch.
- It has had real bugs: CRLF corruption (#1952), edit failures (#2443), event-loop freezing on large files (#1607/#1659).

### 3.2 What the CLI system prompt tells the model

From `src/kimi_cli/agents/default/system.md`:

- "When calling tools, do not provide explanations..."
- "You MUST follow the description of each tool and its parameters..."
- "You have the capability to output any number of tool calls in a single response..."
- "If you anticipate making multiple non-interfering tool calls, you are HIGHLY RECOMMENDED to make them in parallel..."
- "Make MINIMAL changes to achieve the goal."
- "ALWAYS, keep it stupidly simple. Do not overcomplicate things."

The CLI does **not** tell the model "use bash/heredoc freely".  It tells it to use the provided tools.

### 3.3 The mismatch we should avoid

The SWE-agent training almost certainly used **single `strreplace` calls**, not `list[Edit]` batches.  Kimi Code CLI added `list[Edit]` as a harness convenience.  This is a plausible source of the observed behavior in Pi: K2.7 is reluctant to use batch edits and tends to fall back to single edits.

Implication for Pi: a single, simple `edit` tool is closer to the model's native behavior than a fancy batch `edit`.

---

## 4. What other major agents use

| Agent / framework | Editing primitive |
|---|---|
| Anthropic Computer Use | `str_replace_editor` with commands `view`, `create`, `str_replace`, `insert` |
| SWE-agent | `str_replace_editor` + line-range `edit` bash script + lint rollback |
| OpenHands CodeAct | `str_replace_editor` / `edit_file` (LLM-based) + `execute_bash` |
| Claude Code | `Edit` tool: `old_string`, `new_string`, `replace_all` |
| Aider | model-specific formats: `whole`, `diff` (SEARCH/REPLACE), `udiff` |
| Kimi Code CLI | `StrReplaceFile` / `WriteFile` / `ReadFile` / `Shell` |

The common denominator across the strongest coding agents is **exact-match string replacement with `old_string`/`new_string`**, not free-form bash editing.

---

## 5. Unix/bash patterns relevant to the model's training

The model was trained in Unix-heavy environments.  Useful primitives that appear in agent training data:

- `cat << 'EOF' > /tmp/file ... EOF` — heredoc writes (quoted delimiter avoids `$` interpolation).
- `mktemp` + `mv` — atomic file replacement.
- `patch -p0/-p1` — applying unified diffs.
- `sed -n '10,25p' file` — inspect a line range.
- `sed -i` — in-place edit (but fragile for complex escaping).
- `head -n N` / `tail -n +N` — line-range extraction.
- `python3 -c '...'` / `python3 <<'PY'` — Python one-offs.

However, these are mostly used as **fallbacks or helper implementations**, not as the primary agent-facing editing interface.  The primary interface remains structured tool calls.

---

## 6. Design principles for Pi extensions

1. **Match the model's native tool vocabulary.**  Use `edit`/`write`/`read`/`bash` names and `old_string`/`new_string` semantics.
2. **Prefer single edits over batch edits.**  The model was trained on single `strreplace`; batches are a harness add-on.
3. **If batches are needed, expose them as parallel independent tool calls**, not as a complex single-tool schema.  This mirrors the CLI's own "HIGHLY RECOMMENDED" parallel-call guidance.
4. **Keep tool descriptions literal and short.**  K2.7 Code's tool-use tuning rewards clear schemas.
5. **Do not push the model toward bash/heredoc for routine file edits.**  Use structured tools for that.  Reserve bash for tests, git, package install, and genuine shell tasks.
6. **Preserve CRLF/LF/BOM and encoding** on write to avoid the CRLF corruption class of bugs.
7. **Carry `reasoning_content` forward** in multi-turn loops (Pi already does this).

---

## 7. Open questions to validate empirically

- Does K2.7 Code in Pi use `edit` more confidently when the schema is `old_string`/`new_string`/`replace_all` vs. `edits[]`?
- Does removing the batch `edits[]` mode reduce the "fall back to single edits" behavior?
- How does the model behave with `insert`-style line-based edits vs. `str_replace`?
- Is there any advantage to exposing a separate `create` tool vs. using `write`?

---

## 8. References

- Kimi K2.6 Hugging Face model card: https://huggingface.co/moonshotai/Kimi-K2.6
- Kimi K2.7 Code Hugging Face model card: https://huggingface.co/moonshotai/Kimi-K2.7-Code
- Kimi K2 tool-call guidance: https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md
- Kimi Code CLI built-in tools docs: https://moonshotai.github.io/kimi-code/en/reference/tools.html
- Kimi CLI `StrReplaceFile` source: https://github.com/MoonshotAI/kimi-cli/blob/8283d785/src/kimi_cli/tools/file/replace.py
- Kimi CLI `WriteFile` source: https://github.com/MoonshotAI/kimi-cli/blob/8283d785/src/kimi_cli/tools/file/write.py
- Anthropic `str_replace_editor` reference: https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool
- SWE-agent tools docs: https://swe-agent.com/latest/config/tools/
