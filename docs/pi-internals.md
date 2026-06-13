---

## 12. Agent loop context snapshot is immutable during a turn

The core agent loop (`@earendil-works/pi-agent-core`) snapshots `systemPrompt`, `messages`, and `tools` at the start of each user turn. Changes to `agent.state.tools` (e.g. via `pi.setActiveTools()`) do not affect the current turn's snapshot. This is why toggling tools from within a tool call only becomes visible on the next user turn. See `docs/pi-tool-internals.md` §9 for details and workarounds.

---

## 13. `prepareNextTurn` is not wired up by Pi

`AgentLoopConfig` exposes `prepareNextTurn` and it could theoretically refresh the context between turns, but `AgentSession` does not assign it when creating the `Agent` in `dist/core/sdk.js`. Therefore extensions cannot use it to update the active tool set mid-stream. The only reliable ways to change active tools are:
- `pi.setActiveTools()` from a **user turn** (slash command, user bash, or between agent responses).
- `session_start` / `session_tree` handlers.
- Another extension's event handler that runs before the agent's next turn.# Pi CLI Internals — Agent Reference

> Installed version: `0.79.0` (2026-06-08).  
> Install root: `%APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent/`

---

## 1. Where the Code Lives

| What | Path inside package |
|------|---------------------|
| System prompt builder | `dist/core/system-prompt.js` — `buildSystemPrompt(options)` |
| Session runtime | `dist/core/agent-session.js` — `AgentSession` class |
| Resource loader | `dist/core/resource-loader.js` — loads `AGENTS.md`, `SYSTEM.md`, skills, themes, extensions |
| Skills logic | `dist/core/skills.js` — discovery, validation, `formatSkillsForPrompt()` |
| Prompt templates | `dist/core/prompt-templates.js` — `/name` expansion, `$1`, `$@`, `${@:N}` |
| Message types | `dist/core/messages.js` — `bashExecutionToText`, compaction/branch summaries |
| Compaction | `dist/core/compaction/compaction.js` — auto context summarization |
| Config values | `dist/core/resolve-config-value.js` — `$ENV`, `${ENV_VAR}`, `!command`, `$$` escape |

Core streaming engine (`@earendil-works/pi-ai`) lives inside `node_modules/@earendil-works/pi-ai/dist/`.

---

## 2. System Prompt Construction

`buildSystemPrompt(options)` is called every turn (via `_rebuildSystemPrompt`).  
The final text is assembled **in this order**:

```
1. customPrompt          (SYSTEM.md or --system-prompt)
2. appendSystemPrompt    (APPEND_SYSTEM.md)
3. <project_context>     (AGENTS.md / CLAUDE.md wrapped in XML)
4. <available_skills>    (skills wrapped in XML)
5. Default Pi docs block (only when NO customPrompt is set)
   - Available tools list
   - Guidelines list
   - Pi docs paths (readme, docs, examples)
6. Current date: YYYY-MM-DD
7. Current working directory: <cwd>
```

### Key behavior
- If `customPrompt` is present, the **entire default Pi block** (tools list, guidelines, docs references) is skipped. Only tool *definitions* (JSON Schema) are still sent to the provider API.
- `appendSystemPrompt` is always appended, even with a custom prompt.
- `contextFiles` (AGENTS.md / CLAUDE.md) are discovered by walking **from `cwd` up to the filesystem root**. Pi loads the file in `cwd` **plus every ancestor directory** that contains `AGENTS.md`/`CLAUDE.md`, then wraps them together. There is **no built-in setting** to keep only the `cwd` file — use an extension (e.g. `context-guard` with `ancestor-agents`) if you need that.
- `contextFiles` are **always wrapped** by Pi:
  ```xml
  <project_context>
    Project-specific instructions and guidelines:
    <project_instructions path="...">content</project_instructions>
  </project_context>
  ```
- `skills` are **always wrapped** by Pi:
  ```xml
  <available_skills>
    <skill><name>...</name><description>...</description><location>...</location></skill>
  </available_skills>
  ```
- `Current date` and `Current working directory` are **hard-appended** at the very end. There is **no setting** to disable them.

---

## 3. Messages Array (What Goes to the LLM)

Pi maintains `agent.state.messages`. Before each provider request it calls `convertToLlm()` (`dist/core/messages.js`).

| Source | Transformed to |
|--------|---------------|
| User text / images | `role: "user"` |
| Bash execution | `role: "user"` with formatted text (`Ran \`cmd\`\n\`\`\`\noutput\n\`\`\``) |
| Tool results | `role: "toolResult"` |
| Compaction summary | `role: "user"` with `<summary>` block |
| Branch summary | `role: "user"` with `<summary>` block |
| Custom messages | `role: "user"` (extensions via `before_agent_start`) |
| Steering / follow-up | `role: "user"` queued mid-stream |

---

## 4. Extension Hook Order

Extensions are loaded in order (CLI → global → project). Hooks of the same type run in that order.

For `before_agent_start`, each handler receives `event.systemPrompt` **already modified by previous handlers**.

Typical chain in this workspace:
1. `role-sw` — appends `## Role Override (kimi)\n\n<role file content>`
2. `pi-skill-guard` — removes `<available_skills>` block or injects full skill bodies
3. `a-rewind` — no text changes (timer only)
4. `pi-xai-oauth` — no text changes (status only)

If you write a cleanup extension, register it **after** the ones you want to clean up after, or overwrite `systemPrompt` completely.

---

## 5. What Can Be Disabled via Settings / CLI

| Feature | Disable method |
|---------|---------------|
| `AGENTS.md` / `CLAUDE.md` | `--no-context-files` / `noContextFiles: true` in SDK |
| Skills | `--no-skills` / `"skills.enabled": false` |
| Prompt templates | `--no-prompt-templates` |
| Built-in tools | `--no-builtin-tools` |
| All tools | `--no-tools` |
| Specific tools | `--exclude-tools read,grep` or `--tools read,edit` |
| Extensions | `--no-extensions` |
| Themes | `--no-themes` |

**Cannot be disabled by settings:**
- `Current date: ...`
- `Current working directory: ...`
- Ancestor traversal for `AGENTS.md` / `CLAUDE.md` (only `--no-context-files` disables the whole block)
- XML wrapping of AGENTS.md
- XML wrapping of skills
- Tool definitions sent to the provider API

To remove those, use an extension with `before_agent_start` and mutate `event.systemPrompt`.

---

## 6. Config Value Interpolation

Used for API keys, headers, shell command prefixes, etc.

| Syntax | Meaning |
|--------|---------|
| `$ENV_VAR` | Environment variable |
| `${ENV_VAR}` | Environment variable (explicit boundaries) |
| `$$` | Literal `$` |
| `$!` | Literal `!` |
| `!command` | Execute shell command, use stdout as value (cached for process lifetime) |

Implementation: `dist/core/resolve-config-value.js`.

---

## 7. Prompt Templates

Loaded from `~/.pi/agent/prompts/*.md`, `.pi/prompts/*.md`, packages, settings.

Syntax inside template body:
- `$1`, `$2` … positional args
- `$@` or `$ARGUMENTS` — all args joined by space
- `${@:N}` — args from Nth (1-indexed) onwards
- `${@:N:L}` — L args starting at N

**Note:** `${1:-default}` (default values) appears in latest online docs but is **NOT in v0.79.0**. It will arrive in a future release.

---

## 8. Resource Loading Priority

`DefaultResourceLoader.reload()` resolves resources in this order:

1. CLI temporary extensions (`-e`)
2. Global settings (`~/.pi/agent/settings.json`)
3. Project settings (`.pi/settings.json`) — **if project trusted**
4. Package manifests

Precedence for conflicts: CLI > project > global > package.  
Trust prompt appears in interactive mode; non-interactive ignores project-local unless `--approve`.

---

## 9. Compaction

When context tokens exceed `contextWindow - reserveTokens` (default reserve = 16384):
1. Pi finds a cut point in the conversation
2. Calls a summarization LLM with a structured prompt
3. Replaces old messages with a single `compactionSummary` entry
4. Continues the session

Settings:
```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

---

## 10. SDK Types for Extensions

Key types live in `dist/core/extensions/index.d.ts` (and re-exported from package root).

- `ExtensionAPI` — `registerTool`, `registerCommand`, `on(event, handler)`, `sendMessage`, `appendEntry`
- `ExtensionContext` / `ExtensionCommandContext` — `cwd`, `ui`, `sessionManager`, `getSystemPrompt()`, `getSystemPromptOptions()`
- Events: `before_agent_start`, `agent_end`, `turn_end`, `input`, `tool_call`, `tool_result`, `session_start`, `model_select`, `before_provider_request`, `project_trust`

`before_agent_start` return shape:
```typescript
{
  systemPrompt?: string;   // override for this turn
  messages?: Array<{ customType: string; content: ...; display?: boolean; details?: any }>;
}
```

---

## 11. Quick Pitfalls

- **Custom system prompt does NOT prevent tool definitions.** Even with `SYSTEM.md`, Pi still sends JSON Schema for all active tools to the provider. It only skips the *textual* tool list inside the system prompt.
- **AGENTS.md is wrapped unconditionally.** If you want raw AGENTS.md text without `<project_context>` tags, load the file yourself in an extension and inject via `before_agent_start`.
- **`before_agent_start` runs on EVERY turn**, including continuations after compaction or steering. Keep it fast.
- **Extension `messages` from `before_agent_start` go into the LLM context** as `role: "custom"`, which `convertToLlm` transforms to `role: "user"`.
