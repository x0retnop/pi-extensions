# sub-agents

Spawns isolated child `pi` processes for delegated tasks.

## What it does

- `spawn_agent` — primary LLM path: `explorer` / `reviewer` (read-only, may write cwd artifacts) and `coder` (changes project source, leaves it uncommitted).
- Loads agent definitions from the extension folder (`sub-agents/*.md`) only. Files without frontmatter are ignored.

## Agents

| Agent | Access | Returns |
|---|---|---|
| `explorer` | read-only | map + briefing, artifact `explore-*.md` / `map-*.md` when large |
| `reviewer` | read-only | verdict + numbered issues against the stated intent |
| `coder` | writes project source | files changed, what was verified, what was not |
| `handoff-instr` | hidden, `includeExtensions: false` | used only by `/handoff` |

`text-compress` was removed — compression runs in-harness (`context-compressor`), the agent had no runs after Aug 2026.

## Tools and commits

- Children run with the **full tool set minus `spawn_agent`**: `runner.buildPiArgs` always passes `--exclude-tools spawn_agent`. The bundled `handoff-instr` is the one agent that narrows further — its frontmatter carries `tools: read`, so `/handoff` children get `--tools read`. Adding `tools:` to any other agent's frontmatter (or a TUI preset / override) narrows that agent's set the same way.
- **No sub-agent commits.** `coder` leaves changes in the working tree; the parent verifies and commits. No agent may commit, push, stash or rewrite history.

## Important behaviors

- Each child process runs with `PI_SUB_AGENTS_CHILD=1`. The extension detects this and does **not** register its commands/tools inside children, preventing infinite recursion. `role-sw` and `model-manager` also detect it: role-sw composes the child's full system prompt from a role file; model-manager registers curated providers but never switches the child's model.
- Agent definitions are markdown files with YAML frontmatter. Fields: `name`, `description`, `model`, `tools` (optional allowlist — omit for the full set), `includeExtensions`, `extensions`, `role`, `timeoutMs`, `maxTurns`, `deadlineMs`, `idleMs`, `toolIdleMs`, `contextLimitPercent`, `maxExtensions` (0 = caps never extend), `extendGraceMs`, `hidden` (`true` hides the agent from TUI/`spawn_agent` for use by slash commands like `/handoff`). See "Guards" below.
- Model is assigned in frontmatter `model` or `subAgents.agentOverrides.<name>.model` — never in the file name.
- `role` = child system prompt composed by role-sw (`role-sw/roles/<role>.md` + agent body); implies `--no-context-files --no-skills`. Role-sw only loads if the child has extensions (`includeExtensions: true`, or `role-sw` listed). Missing role file → default Pi prompt fallback. Sub-agent roles are plain file names (`sub-default`) — no versioning.
- The role picker (`/sub-agents` → Settings → Role / Default role) lists the same family aliases as `/role`, via `role-sw/roles.ts`.
- TUI model override lists **pinned `/mm` favorites only** (`model-manager.json` → `favorites[]`). Stored value is always `provider/id` (so `xai/grok-4.6`); the picker shows the model display name next to it. Frontmatter / inherit still work if you skip the picker.
- Effective config = frontmatter overridden by `subAgents.agentOverrides.<name>` (settings.json), edited from the `/sub-agents` TUI. Applies to TUI, `spawn_agent`, and `/handoff` alike (`settings.ts → resolveAgent`).
- `spawn_agent` rendering is split the way Pi intends (`tool-execution.js` stacks `renderCall` and `renderResult` in **one** box; the call block is never removed when the result arrives, so a repeated header reads as a duplicate). `renderCall` = one header line (`spawn_agent <agent> @ <cwd> · brief <size>`) plus the first 5 non-empty brief lines (`#` stripped, headings bold) and, when the brief is longer, a last body line `… (N more lines, <expand key> to expand)`. `renderResult` = state line only (`done · 96 turns · $0.1057 · 17m 41s`), plus `guard:`/`error:` when applicable, the **last 5** tool calls (`actions (last 5 of 17):`), and the transcript path; a rejected call (`details: {}`) renders `failed` from the render context's `isError`, not `done`. The expand key (`Ctrl+O` by default) shows the whole brief and every tool call — it comes from `keyHint("app.tools.expand")`, so a rebind is picked up. There is no `taskRenderMode` setting — it was retired (it rendered the brief twice) and is stripped from `settings.json` on save.
- The `spawn_agent` tool can be turned on/off for the current session branch with `/sub` or from the TUI main menu. When off, the tool is removed from the active tool list so the LLM cannot call it. State is stored in the session branch and restored on `session_start`/`session_tree`; the status bar shows `sub:on` when enabled.
- `/new` with no saved state starts **OFF** and writes that to the session. Resume/startup/reload/fork without state stay **ON** (legacy). Existing `sub-agents-state` entries are never rewritten.
- Parent role policy is not baked into the role file. A role may contain `<!-- sub-agents -->`; on `before_agent_start` (after `role-sw`) the marker is replaced with `~/.pi/agent/extensions/role-sw/roles/_Sub-agents.md` when the tool is on, or stripped when off. No marker → no injection. Missing file while on → marker stripped + warning. Do not `{{include:_Sub-agents.md}}` — that would be static and ignore `/sub`.
- Retry is layered, and each layer is slower than the one under it. The child retries transient errors in-run with Pi's own budget (`settings.retry` on this host: 6 attempts, base 2 s, cap 60 s → 2/4/8/16/32/60 s). The runner then **resumes the same child session** up to 2 more times (`RESPAWN_DELAYS_MS` = 60 s / 120 s), handing it a nudge instead of the brief: the child keeps its reads, its reasoning and its own record of what it already changed, so a mid-run blip no longer costs the delegated task and no edit is applied twice.
- The stop list is inverted (`common/retry-policy.ts` → `isHardStopError`): only quota/billing/credits, 401, 403 *with* permission/quota wording, 400 / `invalid_request_error` / `unsupported_request` / model-not-found, and context overflow stop a respawn. A routing 403 (`Upstream request failed`, `Endpoint is unavailable`) retries — the status code decides nothing, the text does. Unrecognised wording retries by default, so new provider strings need no code change. Abort and guard stops never respawn.
- One safety valve: when a *resumed* child is rejected for its own history (a tool call whose stream died before the result → provider 400, or an overflow), the runner spends a single fresh-session attempt on the same task (`isPayloadRejectionError`). Quota and auth never qualify, so a dead key costs no extra spawn.
- Child sessions live in `~/.pi/agent/subagent-sessions/` (`--session-id` + `--session-dir`), are deleted when the run succeeds, and of a failed run are kept for forensics until the `historyRetentionDays` sweep (default 30 days, shared with the transcript history). The transcript header records the session id and how many retries the child burned itself. A failed run's output still carries the transcript path, and the full brief is in that transcript under `## Prompt (brief)`.

## Guards (one attempt)

Four layers, evaluated every 5 s and right after each completed turn. Only the
hard caps are wall-clock; the rest read observed activity, so a slow provider or
a long build is not mistaken for a hang.

| Layer | Default | Fires when | Extends? |
|---|---|---|---|
| `deadlineMs` | 20 min | no **completed turn** for that long, and no tool running | yes — every completed turn or finished tool call pushes it one full deadline ahead |
| `idleMs` | 10 min | **no stdout at all**, no tool running | yes — any byte from the child resets it |
| `toolIdleMs` | 30 min | no stdout while a **tool call is in flight** (long tests are legitimate) | yes — same clock, longer threshold |
| `timeoutMs` / `maxTurns` | 60 min / 300 | always | yes — each fired cap grants one extension of +50% of its base value (see below) |
| `contextLimitPercent` | 40 % | the child's context reaches that share of its window | no — this is the cost guard |

- **Cap extensions.** When the wall-clock or turn cap fires and a turn completed within `extendGraceMs` (default 10 min), the cap is not a kill: it grants one extension (+50% of the base `timeoutMs`, +50% of the base `maxTurns`), at most `maxExtensions` (default 2) per attempt — so the worst case is 2× the base caps. The soft deadline re-anchors at the extended ceiling. A stalled run (no completed turn in the grace window) never qualifies, so the anti-hang protection is unchanged; the context cap stays absolute. The final stop reason names the effective ceiling and the extensions used: `hard limit reached (1h 30m (incl. 1 extension))`. Set `maxExtensions: 0` (frontmatter or override) to restore the old never-extend behavior.
- The deadline is **suspended** while a tool runs: a turn cannot complete until the tool returns, so `toolIdleMs` governs instead.
- `idleMs` must stay above Pi's own `httpIdleTimeoutMs` (5 min), otherwise the guard kills the child before its own retry logic gets a chance. Pi's stream-idle abort emits events, which also count as activity.
- The context percentage comes from the provider's own usage for the last turn (`usage.totalTokens`, same as the runtime's `calculateContextTokens`) divided by the window resolved by the `provider`/`model` the child reports — `models-store.json` first, then `models.json`, then Pi's built-in catalogue (`getModel` from `@earendil-works/pi-ai/compat`, the same read `model-manager` uses). The built-in layer is what keeps a stock-but-recent model alive: the store is a pi.dev cache and stays frozen while `PI_OFFLINE=1`, so `xai/grok-4.7` (in the store's key only from a later fetch) would otherwise read as unknown and silently lose both the `ctx %` label and the 40% context stop. Unknown to all three → the guard is skipped (logged at debug), never guessed.
- **A guard stop is not a crash.** The attempt keeps every message it produced: the tool result carries `[stopped by guard: <reason> after <time>]`, the child's last assistant text and the transcript path. `exitCode` is non-zero, the result is flagged `interrupted`, and it is never respawned by the retry logic.
- Killing goes through the whole process tree (`taskkill /F /T` on Windows, SIGTERM→SIGKILL elsewhere). On Windows `child.kill('SIGTERM')` is `TerminateProcess` on the direct child only — the child's own signal handlers never run, so `bash` processes it detached would otherwise survive the parent.
- Per-agent knobs sit next to `timeoutMs`/`maxTurns` in the frontmatter and in the TUI override editor (`/sub-agents` → Settings). The editor's ms knobs display human first (`10m (600000 ms)`) and accept either unit back (`10m`, `1h30m`, plain ms — `common/duration.ts`). `contextLimitPercent: 0` disables the context guard for that agent.
- Every run writes a markdown transcript (`*.transcript.md`) to the history dir; the TUI "Recent runs" screen can open it. Sections: header (`Agent`/`Model`/`Role`/`Tools`/`CWD`/`Attempt`/`Duration`/`Exit code`/`Usage`), `## Prompt (brief)` — the parent's brief **whole**, fenced so its own `#` headings cannot be confused with the file's sections, `## Stderr` — only when the child actually wrote any, `## Messages` — per-message, capped (1000 arg / 2000 result / 2000 text), `## Final message` — the report, capped at 20k. One file per attempt (a retried run leaves one per attempt).
- Handoff reads the current session branch via `ctx.sessionManager.getBranch()`, formats it, and asks a child agent to produce markdown.
- **Handoff.** `handoff-instr` runs with `includeExtensions: false`. The `.md` body is the full child prompt; role frontmatter is unused (role-sw never loads). Model: `opencode-go/deepseek-v4-flash`. Do not flip `includeExtensions` or wire the role to "fix" it.
- Child output is written to `cwd` as a markdown file.
- Handoff summaries may mention that specific details remain in the session history; those are found in the raw session (`/sw` preview or Markdown export), not by an agent tool.

## Child prompt composition

A child is a separate `pi` process. From the parent's conversation it receives **only the `task` string** — the
runner writes it to the child's stdin as its first user message. No parent history, no automatic injection.

CLI args (`runner.buildPiArgs`): `--mode json -p --no-session --exclude-tools spawn_agent`, plus `--model` and
`--tools` when set, plus `--no-context-files --no-skills` when the agent has a role, plus
`--no-extensions --extension …` when not loading all extensions, plus `--append-system-prompt <temp file>` with
the agent body. Env: `PI_SUB_AGENTS_CHILD=1`, and with a role also `PI_SUB_AGENT_ROLE` / `PI_SUB_AGENT_PROMPT_FILE`.

**Role-driven child (default — `subAgents.defaultRole` or a role override).** role-sw replaces the *entire*
system prompt in `before_agent_start`, in this order:

1. `role-sw/roles/<role>.md` — frontmatter stripped, `{{include: name.md}}` expanded (same dir);
2. the agent body (the file also passed as `--append-system-prompt`);
3. `Current working directory: <cwd>`.

`BeforeAgentStartEventResult.systemPrompt` **replaces** the prompt, and role-sw loads after context-guard
(that order is documented in `context-guard/prompt-rules.ts`). So in a role-driven child nothing else reaches the
model: not Pi's default prompt, not `SYSTEM.md`, not context files or skills (the flags exclude them anyway), not
context-guard's prompt rules. context-guard's AGENTS.md inject is skipped outright for children
(`agents-inject.ts` returns false when `PI_SUB_AGENTS_CHILD === 1`).

**No role** (`agentOverrides.<name>.role = "none"`): the child keeps Pi's default prompt with the agent body
appended, and context-guard behaves as in a normal session.

One owner per layer when editing: runtime/transport behaviour (model, tools, args) → `runner.ts` and
`agentOverrides`; shared framing that every sub-agent gets → the role file; contract + report format → the agent
file; the run's brief → the `task` argument, whose required shape lives in the `spawn_agent` description.

## State

- `~/.pi/agent/settings.json` → `subAgents` (`defaultCwd`, `defaultRole`, `historyRetentionDays`, `debugLog`, `agentOverrides`). Legacy keys (`parallelConcurrency`, `lastAgent`, `lastMode`, `taskRenderMode`, old extension-policy) are stripped on save.
- `~/.pi/agent/sub-agents-history/` — one JSON file + one `.transcript.md` per run.

## Dependencies

- Agents with a `role` require `role-sw` in the child — set `includeExtensions: true` (spawn agents already do). The runner does not force the full set.
- Agents on curated providers (e.g. `opencode-go/...`) require `model-manager` in the child to resolve `--model` (same: `includeExtensions: true`).

## Rendering

`spawn_agent` draws its own `Container` and both slots stay stable while the child runs:

- collapsed call line is header + a 5-line brief preview with `… (N more lines, Ctrl+O to expand)`;
  Ctrl+O shows the whole brief.
- the result block exists from the first partial update (`running… 12s · 3 turns · ctx 41%`) — it never
  appears as a 0 -> N jump — and settles into `done · 9 turns · $0.1987 · 1m 24s`, the last 5 tool
  calls (all of them expanded), and the transcript path.
- a failed run shows `failed` plus the first line of the error while collapsed; every failure path
  (guard stop, unknown/unconfigured agent) returns `isError: true`.
