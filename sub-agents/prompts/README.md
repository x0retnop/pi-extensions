# sub-agents prompts documentation

This folder collects engineering notes and prompt-design patterns for the `pi-sub-agents` extension. The goal is to keep subagent behavior predictable, tool usage correct, and handoffs useful — without hype or generic "be helpful" instructions.

## Core design principles

1. **Subagents are context isolation, not magic.** A subagent gets a fresh context window and only what you put in its `task`. It cannot see the parent conversation. Every prompt must be self-contained.
2. **One agent, one role.** Each agent should have a narrow responsibility (scout, planner, worker, reviewer). If a subagent needs the full project context to do its job, the boundary is wrong.
3. **Clear inputs, clear outputs.** The parent should know exactly what the subagent will return. Freeform "do whatever" prompts produce freeform garbage.
4. **Parent keeps control.** Subagent does the noisy work; parent synthesizes and decides. Do not delegate understanding.
5. **Return concise structured results.** The whole point is to avoid context bloat. Subagent output should fit in ~1-2K tokens.

## Agent prompt structure

Every agent `.md` file should follow this structure:

```markdown
---
name: agent-name
description: One-sentence when-to-use description. The parent agent reads this to decide delegation.
model: provider/model-id
tools: read, grep, find, ls
includeExtensions: true
timeoutMs: 600000
maxTurns: 50
---

You are an expert [role] specializing in [narrow domain].

**Your Core Responsibilities:**
1. ...
2. ...

**Process:**
1. ...
2. ...

**Output Format:**
...

**Constraints:**
...

**Edge Cases:**
- ...
```

## Tool description design

The parent agent decides whether to call `subagent` based on its `description` and `promptGuidelines`. Good descriptions mention:

- **When to delegate** (verbose recon, isolated coding, parallel review).
- **What each bundled agent does** (scout = read-only recon, worker = edits/refactor).
- **Concrete JSON shapes** with realistic examples.
- **What the parent receives back** (a summary, a plan, edited files).

Avoid abstract words like "delegate", "specialized", "orchestrate" without a concrete payoff. The agent needs a reason to pay the latency cost of spawning a subprocess.

## Handoff prompt design

A handoff agent must produce a document that the next agent can act on. Required sections:

- **What was the goal and what is unfinished.**
- **Exact files and code locations involved.**
- **Decisions already made** (so the next agent does not re-decide).
- **Concrete next command or first file to open.**

Avoid generic summaries like "we worked on X". Prefer: "Open `engine.ts:88` and finish the `applyEdits` sequential fallback."

## In this folder

- `tool-description.md` — parent-facing `subagent` tool description and `promptGuidelines`.
- `handoff-gemma-prompt.md` — system prompt for the handoff writer.
- `scout-gemma-prompt.md` — system prompt for the read-only scout.
- `flash-worker-prompt.md` — system prompt for the coding worker.
- `workflow-recipes.md` — concrete single/parallel/chain examples.

## References

- Anthropic: system-prompt-design.md
- Piebald-AI/claude-code-system-prompts: system-prompt-writing-subagent-prompts.md
- LangChain subagent docs: context isolation and tool-per-agent patterns.
