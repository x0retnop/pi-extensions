# context-trim

Manual one-shot superseded full-read trim. **No auto.**

## Mechanics

1. `/trim` builds a fixed map `toolCallId → stub text` from current messages.
2. Policy: last successful **full** `read` per path kept; earlier ones ≥ minChars stubbed.
3. Full = raw/default without offset/limit/target/overview/section.
4. `context` hook only re-injects that frozen map — no re-scan, no cold-start detection.
5. Session JSONL unchanged. State custom entry: `context-trim-state`.

Status bar while stubs active: `trim:N` or `trim:N·120k`.

## When to use

Cold start only: long idle, `/resume` of a fat session, before a new task.  
Not for continuous hot-loop trimming.
