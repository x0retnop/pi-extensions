# Pi Tool Internals — What Gets Sent to the LLM

Quick reference for agents building or debugging tools. Based on Pi CLI source in `node_modules/@earendil-works/pi-coding-agent/dist/` and nested `@earendil-works/pi-agent-core`. Covers visibility, payloads, and **parallel tool-call batching** (§8).

---

## 1. When does `pi.setActiveTools()` take effect?

`pi.setActiveTools()` updates `agent.state.tools` and rebuilds the base system prompt immediately, but it does **not** change the tool snapshot that the current agent loop is using.

The agent loop (`@earendil-works/pi-agent-core/dist/agent-loop.js`) creates a context snapshot at the start of each user turn:

```js
function createContextSnapshot() {
  return {
    systemPrompt: this._state.systemPrompt,
    messages: this._state.messages.slice(),
    tools: this._state.tools.slice(),
  };
}
```

All tool calls within that turn use `currentContext.tools`. There is no `prepareNextTurn` hook wired up by Pi, so the snapshot is never refreshed mid-turn.

### Practical consequence

If a tool calls `pi.setActiveTools([...])` during its execute, the new tool set is visible to the LLM only on the **next user turn** (or after a continuation that starts a new `runAgentLoop`).

If you need a tool to "unlock" other tools and use them in the same turn, use one of these workarounds:

1. **Keep the target tools registered but validate a gate flag inside them.** The tools are always visible; they return an error if the gate is closed.
2. **Make the gate tool perform the work itself.** Instead of toggling visibility, implement the `web_search`/`fetch_content`/etc. logic behind a single always-visible gateway tool.
3. **Use a user slash command for the toggle.** Commands run in a separate user turn, so `setActiveTools()` is applied before the agent's next response. Example pattern: `/web` toggles web tools on/off; when off the agent sees no web tools at all, when on it sees the full web tools.

### Verification

In Pi source:
- `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js` — `createContextSnapshot()` and `createLoopConfig()`.
- `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` — `runLoop()` uses `currentContext.tools` for every tool call batch.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js` — `new Agent({ ... })` does **not** set `prepareNextTurn`, so the loop cannot refresh tools mid-turn.

1. Extension calls `pi.registerTool({ name, description, parameters, execute, ... })`.
2. Pi stores it in the global tool registry (`_toolDefinitions`).
3. At session start / rebuild Pi calls `setActiveToolsByName(toolNames)`.
4. Only active tools land in `agent.state.tools`.
5. Only `agent.state.tools` are serialized into the provider request.

So: **registered ≠ active ≠ visible to LLM**.

---

## 2. What the LLM actually receives

For every active tool Pi sends a definition containing at least:

```json
{
  "name": "grep",
  "description": "Fast structured search via ripgrep...",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string", "description": "..." }
    },
    "required": ["pattern"]
  }
}
```

The LLM does **not** see:
- `label`
- `promptSnippet` / `promptGuidelines` (not in the tool block; they only feed the *default* Pi system block, skipped under a custom prompt — see §3)
- inactive tools
- source paths

---

## 3. Field roles

| Field | Sent to LLM? | Purpose |
|---|---|---|
| `name` | yes | Technical identifier for the tool call. |
| `description` | yes | Tells the LLM **what the tool does and when to use it**. This is the main steering text. |
| `parameters` | yes | JSON Schema. Tells the LLM **how** to call the tool: field names, types, enums, required fields. |
| `parameters.<field>.description` | yes | Tells the LLM the meaning of each argument. |
| `promptSnippet` | no | Feeds the "Available tools" list in Pi's *default* system block — skipped whenever a custom prompt is set. |
| `promptGuidelines` | no | Feeds the "Guidelines" list in Pi's *default* system block — same skip; never sent on a role-driven host (see below). |
| `label` | no | UI label for TUI. |
| `renderCall` / `renderResult` | no | TUI rendering hooks. |

Neither `promptSnippet` nor `promptGuidelines` is part of the tool payload; both land only in the default Pi system block, which is skipped when a custom prompt is set.

### What actually reaches the model (payload-verified 2026-09-16)

The provider payload has exactly two text sources:
- the `system` string (here: the role; `customPrompt` is always set via the `SYSTEM.md` canary + `role-sw`), and
- each active tool's JSON schema: `name` + `description` + `parameters` (field `description`s included).

`promptSnippet`/`promptGuidelines` are **never** in that payload — `buildSystemPrompt` early-returns
under `if (customPrompt) { … return prompt2; }` (bundle `chunk-5OEJBNHG.js`, 1.0.1), before the default
block that would consume them is built.

Consequence: to steer behavior, put text in `description` or `parameters.<field>.description`;
put cross-tool policy in the role / `SYSTEM.md`. Do not rely on `promptSnippet`/`promptGuidelines`.

Why it looked like guidelines worked: `read-mode` duplicated its guidance *inside* `description`,
so it arrived via the schema; tools that kept guidance only in `promptGuidelines`
(`web-search-st`, `edit`/`insert`, `pwsh`) silently lost it. On 2026-09-16 every live tool's
`promptSnippet`/`promptGuidelines` were removed and the essentials folded into `description`/params.

Evidence: `~/.pi/agent/logs/payload-trace/cap-*/req-*.json` — in `tools[]` the count of
`promptGuidelines`/`promptSnippet` is 0 and `function` keys are `description, name, parameters, strict`.

---

## 4. System prompt construction

From `docs/pi-internals.md` §2:

```
1. customPrompt          (SYSTEM.md or --system-prompt)
2. appendSystemPrompt    (APPEND_SYSTEM.md)
3. <project_context>     (AGENTS.md / CLAUDE.md)
4. <available_skills>
5. Default Pi docs block  ← only when NO customPrompt is set
   - Available tools list (uses promptSnippet)
   - Guidelines list      (uses promptGuidelines)
6. Current working directory
```

(`Current date` was removed from the default prompt in Pi 0.80.7; see `docs/pi-internals.md` §2.)  
This host: P-3/P-4 skip steps 3–4. AGENTS is not in the system prompt.

Key implication: **with a custom system prompt the textual tool list is skipped**, but the tool JSON schemas are still sent to the provider.

---

## 5. Which tools are active by default

Built-in tools and their default activation state. Source of truth is the bundle, not `--help`: the
system-prompt builder uses `selectedTools || ["read","bash","edit","write"]` (`chunk-5OEJBNHG.js`, 1.0.1),
which `defaultTools` in settings / `--tools` / `--no-builtin-tools` replace.

| Tool | Default |
|---|---|
| `read` | on |
| `bash` | on |
| `edit` | on |
| `write` | on |
| `grep` | **off** |
| `find` | **off** |
| `ls`   | **off** |
| `powershell` | **off** — do not enable (runtime P-1 note; `pwsh` from `pi-agent-run` covers it) |

Cost of the active set (payload-verified 2026-09-20, `~/.pi/agent/logs/payload-trace/`): 12 active tools
= **18.1 KB** of JSON schema per request vs **5.0 KB** for the system prompt — the tools block is ~78% of
the static prefix, so a tool that is never called is not free. This host's set is already trimmed
(`find`/`ls`/`powershell` absent; `grep`/`read`/`edit` are the extension overrides).

Extension tools are active unless excluded by:
- `--no-tools`
- `--no-builtin-tools` (only built-ins)
- `--tools a,b,c`
- `--exclude-tools x,y`
- SDK settings (`tools`, `excludeTools`)
- another extension calling `pi.setActiveTools([...])`

---

## 6. How to inspect active vs registered tools

There is no built-in command for this; inspect programmatically from an extension:

```ts
const all = pi.getAllTools();           // ToolInfo[]
const active = pi.getActiveTools();     // string[]
const isActive = active.includes("grep");
```

---

## 7. Writing descriptions that LLMs understand

Bad:
```ts
description: "Read files"
```

Good:
```ts
description:
  "Read file contents with mode-based navigation. " +
  "Use mode:overview FIRST for unfamiliar files >200 lines. " +
  "Use mode:section with a target name to read a specific block."
```

For parameters:
```ts
parameters: Type.Object({
  pattern: Type.String({
    description:
      "Regular expression to search for (treated as regex by default). " +
      "If the value contains regex metacharacters such as . ( ) [ ] ... " +
      "set fixed_strings: true to avoid parse errors."
  })
})
```

Rule of thumb: `description` is an instruction to the LLM, not documentation for the user.

---

## 8. Parallel tool calls (agent-loop batching)

There is **no** `parallel` field in tool JSON schemas. Parallelism is:

1. **Model:** emit **multiple** `toolCall` blocks in **one** assistant message.
2. **Runtime:** execute that batch (default concurrent), then send **all** results in the **next** provider request.

### Runtime defaults

Source: `@earendil-works/pi-agent-core` (`agent-loop.js`, `Agent.toolExecution`).

| Setting | Where | Default |
|---------|--------|---------|
| Global `toolExecution` | Agent constructor / loop config | `"parallel"` |
| Per-tool `executionMode` | `registerTool({ executionMode })` | omit = follow global |
| Pi CLI `settings.json` | — | **not exposed**; coding-agent does not pass `toolExecution` |

Rules:

- `"parallel"`: `beforeToolCall` / arg validation run **sequentially**; allowed `execute` runs via `Promise.all`.
- `"sequential"`: prepare → execute → finalize one-by-one.
- If **any** tool in the batch has `executionMode: "sequential"`, the **entire** batch is sequential.
- Workspace extensions (read-mode, grep-tool, pi-multi-edit, web tools, spawn_agent, …) do **not** set `executionMode` → all batch-parallel capable.
- Soft serialization inside tools still applies: `pi-multi-edit` `withFileLock` per absolute path (same file queues; different files concurrent). Built-in `write`/`edit` use a similar per-path queue.

### Provider traffic and cost

```
HTTP #1  full context → assistant with N toolCalls
LOCAL    execute N tools (no LLM HTTP)
HTTP #2  full context + assistant + ALL N toolResults → next assistant
```

Not: one HTTP per tool result. Billing/quota track **LLM turns**, not tool count. Each next request still re-sends history (results accumulate as input tokens until compaction/trim). Parallel batching saves **round-trips** when the model would otherwise serialize independent calls across turns.

Provider payload shape (one request body):

| API family | How consecutive `toolResult` messages are sent |
|------------|--------------------------------------------------|
| OpenAI-compatible | separate `role: "tool"` messages + `tool_call_id` |
| Anthropic / Bedrock | merged into one `user` message with multiple `tool_result` blocks |

### Intra-tool parallel (not agent-loop)

One tool call can still fan out internally, e.g. `web_search` `queries[]`, `fetch_content` `urls[]`. That is independent of multi-`toolCall` batching.

### Teaching the model (where to put text)

| Put here | Content |
|----------|---------|
| Role / AGENTS / system | Policy: independent steps → multiple tool calls in **same** assistant turn; sequential turns only when step N+1 needs N's output |
| Tool `description` / params | How to call **this** tool; optional one-liner that independent calls may share a turn; API of multi-arg fan-out (`queries`, `urls`) |
| `promptGuidelines` / snippets | Only land in default Pi system block; **skipped** when custom system prompt / empty SYSTEM + role-only persona — prefer `description` + role |

Pi default system prompt does **not** teach multi-tool batching. Older base roles carried an explicit **Tool call batching** section (agent-core-v2, retired `base-v1-kimi-k3`); `prompts_dev/ready/agent-core-v3.md` deliberately drops it — v3-class models batch independent calls without a written policy. A gateway may still insert its own tool preamble (not in Pi's JSON) — measure with `docs/scripts/provider_inject_probe.md`.

### Source paths

- `…/pi-agent-core/dist/agent-loop.js` — `executeToolCalls` / `executeToolCallsParallel` / `runLoop`
- `…/pi-agent-core/dist/agent.js` — `toolExecution ?? "parallel"`
- `…/pi-agent-core/dist/types.d.ts` — `ToolExecutionMode`, `executionMode`
- `…/pi-ai/dist/api/openai-completions.js`, `anthropic-messages.js` — toolResult serialization

---

## 9. Where to read the source

- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
  - `getAllTools()`
  - `setActiveToolsByName(toolNames)`
  - `agent.state.tools`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
  - `ToolDefinition`, `ToolInfo`, `ExtensionAPI`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/*.js`
  - built-in tool implementations
