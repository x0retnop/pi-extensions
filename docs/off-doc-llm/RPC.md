# RPC Mode & JSON Event Stream

> Two headless modes for integration.

---

## RPC Mode

```
pi --mode rpc [options]
```

JSON protocol over stdin/stdout. Each line is a command (stdin) or event/response (stdout).

### Framing

- Strict JSONL: `\n` delimiter only
- Strip trailing `\r` from input
- Do NOT use Node `readline` (splits on U+2028/U+2029)

### Commands

```json
// Prompt
{"id": "req-1", "type": "prompt", "message": "Hello", "streamingBehavior": "steer"}
{"type": "prompt", "message": "With image", "images": [{"type": "image", "data": "base64...", "mimeType": "image/png"}]}

// Steer during streaming
{"type": "steer", "message": "Focus on errors"}

// Abort
{"type": "abort"}

// Session management
{"type": "get_session"}
{"type": "new_session", "options": {"name": "my session"}}
{"type": "get_entries"}

// Tool control
{"type": "set_tools", "tools": ["read", "bash"]}

// Health
{"type": "ping"}
```

### Response format

```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true}
{"type": "response", "command": "ping", "success": true, "data": "pong"}
```

`success: true` means accepted/queued. Failures after acceptance go through event stream.

### Options

| Flag | Effect |
|------|--------|
| `--provider <name>` | Set provider |
| `--model <pattern>` | Model pattern |
| `--name <name>` / `-n` | Session display name |
| `--no-session` | Ephemeral |
| `--session-dir <path>` | Custom session storage |

### Extension commands in RPC

If message starts with `/mycommand`, extension commands execute immediately even during streaming. Extension commands manage LLM interaction via `pi.sendMessage()`.

### Streaming behavior

| `streamingBehavior` | Effect |
|---------------------|--------|
| `"steer"` | Queue, deliver after current tool calls finish |
| `"followUp"` | Wait until agent stops |
| (omitted if idle) | Send immediately |

---

## JSON Event Stream Mode

```
pi --mode json "Your prompt"
```

Outputs all `AgentSessionEvent` as JSON lines to stdout, then exits.

### Key events

```json
{"type": "agent_start"}
{"type": "message_start", "message": {...}}
{"type": "message_update", "message": {...}, "assistantMessageEvent": {"type": "text_delta", "delta": "Hello"}}
{"type": "message_end", "message": {...}}
{"type": "tool_execution_start", "toolCallId": "call1", "toolName": "bash", "args": {"command": "ls"}}
{"type": "tool_execution_end", "toolCallId": "call1", "toolName": "bash", "result": {...}, "isError": false}
{"type": "agent_end", "messages": [...]}
```

First line is session header (`type: "header"`).
