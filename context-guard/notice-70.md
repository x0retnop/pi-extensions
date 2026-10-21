[runtime notice — context ~70%]
Context is about 70% full. Do not expand scope. Wrap up the current task:
1. Summarize the session in 3–5 bullets: goal, decisions made, blockers, and the next concrete step.
2. Write `handoff-<topic>.md` in the project root from that summary yourself (`<topic>` = 2–4 word slug, e.g. `context-guard-trigger-rewrite`). Do not spawn an agent for this — `/handoff` is a user command.
3. Stage and commit only the current task’s changes with a prefix matching the affected area (e.g., `[context-guard]`, `[root]`, `[docs]`, or `[<ext>]`).
4. Stop and return a concise one-paragraph report: what was done, what is left, and the handoff file path.
