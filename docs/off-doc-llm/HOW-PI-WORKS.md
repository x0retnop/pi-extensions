# How Pi Works
> Adapted from bundled docs `how-pi-works.md` (Pi 1.0.1; the installed package wins if they disagree).

Pi coordinates model requests, tool execution, context assembly, and session storage. A session is the record of a conversation: messages, tool calls and results, model changes, compactions, and other events.

Messages and events form a tree. Each path through that tree is a branch. The branch ending at the current entry is the active branch. It supplies the history for the next model request.

## Agent loop

A submitted message is added to the active branch. Pi builds a model request from the system prompt, the active branch, available tools, and model settings, then sends it through the selected provider.

The provider streams an assistant response, which can contain text and tool calls. Pi records the response, executes each tool call, and records the results. That completes one turn. If tool results or queued messages require another model request, Pi starts another turn. Otherwise the run ends.

| Input | When it enters |
|---|---|
| Steering message | After the current assistant turn |
| Follow-up message | After the agent has finished its pending work |
| Abort | Stops the current run. Returns queued messages to the editor |

## Context

The active branch supplies conversation history. Pi converts its session entries into model-compatible user, assistant, and tool-result messages.

| Piece | Role |
|---|---|
| System prompt | Built from Pi's base instructions and discovered context files |
| Tool definitions | Carried on the request |
| Skill descriptions | Carried on the request. Full skill instructions load on demand |
| Extensions | Can add instructions or transform context |
| Prompt templates | Expand editor input before it becomes a user message |
| Selected files, images, pasted text, shell output | Can become message content |

## Sessions

Persistent sessions are JSONL files. Each tree entry has an ID and refers to its parent. The current entry identifies the active branch. Model context is reconstructed from the active branch.

| Action | Effect |
|---|---|
| Continue from an earlier entry | Another branch in the same file |
| Fork or clone | Copies selected history into a new session file |
| Compaction | Inserts a summary entry that replaces older messages in later model requests. Original entries stay in the session tree |

## Interfaces

| Interface | Behavior |
|---|---|
| Interactive | Renders session and agent events in the terminal |
| Print | Runs a prompt and writes the final response |
| JSON | Writes agent events as JSONL |
| RPC | JSONL commands on stdin. Responses and events on stdout |
| TypeScript SDK | Creates and controls agent sessions in process |

All interfaces use the same agent and session mechanisms.

## Extensions and resources

Extensions are TypeScript modules loaded into the Pi process. Factory functions register tools, commands, shortcuts, providers, event handlers, renderers, and terminal UI.

| Resource | Provides |
|---|---|
| Skills | On-demand instructions and supporting files |
| Prompt templates | Reusable message text |
| Themes | Terminal colors |
| Pi packages | Distribute these resources through npm or git |

## Trust and permissions

Project trust is resolved before project settings and resources load. After that trust decision and project-resource loading, Pi loads context files. Enabled tools use the operating-system permissions of the Pi process. Extensions execute inside that process.
