# Compaction & Branch Summarization

> Two mechanisms to reduce context usage.

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, or `/compact` | Summarize old messages |
| Branch summarization | `/tree` navigation | Preserve context on branch switch |

---

## Compaction

### Trigger condition

```
contextTokens > contextWindow - reserveTokens
```

`reserveTokens` default: 16384 (configurable in settings).

### Process

1. Walk backwards from newest message, accumulate token estimates until `keepRecentTokens` (default 20k, configurable)
2. Extract messages from previous kept boundary (or session start) to cut point
3. LLM generates structured summary
4. Append `CompactionEntry` with summary + `firstKeptEntryId`
5. Session reloads using summary + messages from `firstKeptEntryId` onwards

```
Before:
  [0:hdr][1:usr][2:ass][3:tool][4:usr][5:ass][6:tool][7:tool][8:ass][9:tool]
         └──────┬──────┘ └───────────────────┬──────────────────────┘
        summarized (→new entry)          kept (4+)

After:
  [0:hdr][10:compaction{firstKeptEntryId:4}][4:usr][5:ass][6:tool]...
```

### Summary format

```typescript
interface CompactionSummary {
  messages: { role: string; summary: string }[];   // Per-message summaries
  completedTasks: string[];
  pendingTasks: string[];
  filesRead: string[];
  filesWritten: string[];
  decisions: string[];
  importantContext: string[];                       // Current project understanding
}
```

### Manual compaction

```
/compact Focus on the API design decisions
```

---

## Branch summarization

Triggered on `/tree` branch switch. Creates `BranchSummaryEntry` with same `CompactionSummary` format, but persists the summary without removing original entries (the original branch remains intact).

---

## Extension hooks

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  // event: { preparation: CompactionPreparation, branchEntries: SessionEntry[],
  //          customInstructions?, reason: "manual" | "threshold" | "overflow",
  //          willRetry: boolean, signal: AbortSignal }
  // Return { cancel: true } to abort, { compaction } to supply your own summary
  return { cancel: false };
});

pi.on("session_compact", async (event, ctx) => {
  // event: { compactionEntry: CompactionEntry, fromExtension: boolean,
  //          reason: "manual" | "threshold" | "overflow", willRetry: boolean }
  // After compaction — read-only hook, void return
});
```

---

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `keepRecentTokens` | number | 20000 | Tokens to keep after cut point |
| `reserveTokens` | number | 16384 | Reserve for LLM response |
