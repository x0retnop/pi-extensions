# Pi Tool Internals — What Gets Sent to the LLM

Quick reference for agents building or debugging tools. Based on Pi CLI source in `node_modules/@earendil-works/pi-coding-agent/dist/`.

---

## 9. When does `pi.setActiveTools()` take effect?

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
2. **Make the gate tool perform the work itself.** Instead of toggling visibility, implement `web_search`/`fetch_content`/etc. logic behind a single tool like `web_access`.
3. **Use a user slash command for the toggle.** Commands run in a separate user turn, so `setActiveTools()` is applied before the agent's next response. Example pattern: `/web` toggles web tools on/off; when off the agent sees only `web_access`, when on it sees the full web tools.

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
- `promptSnippet`
- `promptGuidelines` directly inside the tool block (see below)
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
| `promptSnippet` | no* | Used in the textual "Available tools" section of the default system prompt only when no custom prompt is set. |
| `promptGuidelines` | no* | Appended to the system prompt Guidelines section when this tool is active. Strong influence on behavior. |
| `label` | no | UI label for TUI. |
| `renderCall` / `renderResult` | no | TUI rendering hooks. |

\* Not part of the tool definition payload, but injected into the system prompt string when conditions are met.

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
6. Current date
7. Current working directory
```

Key implication: **with a custom system prompt the textual tool list is skipped**, but the tool JSON schemas are still sent to the provider.

---

## 5. Which tools are active by default

Built-in tools and their default activation state (Pi CLI `--help`):

| Tool | Default |
|---|---|
| `read` | on |
| `bash` | on |
| `edit` | on |
| `write` | on |
| `grep` | **off** |
| `find` | **off** |
| `ls`   | **off** |

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

## 8. Where to read the source

- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
  - `getAllTools()`
  - `setActiveToolsByName(toolNames)`
  - `agent.state.tools`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
  - `ToolDefinition`, `ToolInfo`, `ExtensionAPI`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/*.js`
  - built-in tool implementations
