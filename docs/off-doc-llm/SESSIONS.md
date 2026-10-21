# Sessions

> Auto-save to `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`.
> Tree structure via `id`/`parentId` — branching without new files.

---

## CLI session flags

| Flag | Description |
|------|-------------|
| `pi -c` | Resume most recent session |
| `pi -r` | Browse and select |
| `pi --no-session` | Ephemeral mode |
| `pi --name "my task"` | Set display name |
| `pi --session <path\|id>` | Specific session file |
| `pi --fork <path\|id>` | Fork into new session |

---

## Session commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse previous sessions |
| `/new` | Start new session |
| `/name <name>` | Set display name |
| `/session` | Show session info |
| `/tree` | Navigate tree |
| `/fork` | New session from previous user message |
| `/clone` | Duplicate active branch |
| `/compact [prompt]` | Manual compact |
| `/export [file]` | Export to HTML/JSONL |
| `/import <file>` | Import JSONL |
| `/share` | Upload as GitHub gist |

---

## Session file format (JSONL)

```typescript
// Version 3 (current): tree structure, "custom" role
// Each line is JSON with a "type" field

interface SessionHeader {
  type: "header";
  id: string;
  version: 3;
  tree: { rootId: string; branches: Record<string, { parentId: string }> };
  createdAt: number;
  updatedAt: number;
  name?: string;
  agentVersion?: string;
  workingDirectory?: string;
}

interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  message: AgentMessage;
  createdAt: number;
  label?: string;
  metadata?: Record<string, any>;
}

interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string | null;
  summary: CompactionSummary;
  firstKeptEntryId: string;
  createdAt: number;
}
```

Full types in `TYPES.md` — `AgentMessage`, `SessionEntry`, `CompactionSummary`.

---

## SessionManager API (ctx.sessionManager)

```typescript
interface SessionManager {
  getEntries(): SessionEntry[];
  getActiveEntry(): SessionEntry | undefined;
  getEntry(id: string): SessionEntry | undefined;
  getActiveBranchIds(): string[];
  getLabel(entryId: string): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  getHeader(): SessionHeader;
  getSessionFile(): string | undefined;
  getTokenCount(message?: AgentMessage): number;
  save(): Promise<void>;
  load(file: string): Promise<void>;
}
```

### Usage in extensions

```typescript
pi.on("session_start", async (_event, ctx) => {
  // Restore custom state
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // entry.data — your persisted state
    }
  }
});

// Label for bookmarks
pi.setLabel(entryId, "checkpoint-before-refactor");
const label = ctx.sessionManager.getLabel(entryId);
```

---

## Delete sessions

- `/resume` → select → Ctrl+D → confirm
- Trash CLI used when available
- Manual: delete `.jsonl` files from `~/.pi/agent/sessions/`
