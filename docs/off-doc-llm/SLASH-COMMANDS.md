# Slash Commands
> Adapted from bundled docs `slash-commands.md` (Pi 1.0.1; the installed package wins if they disagree).

Type `/` in the terminal editor to search commands available in the current session. Built-in commands are listed below. Extensions, prompt templates, and skills can add commands. The in-session command menu is the exact reference for what is loaded.

## Models and settings

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/thinking [level]` | Set the thinking level |
| `/scoped-models` | Configure the models used by interactive cycling |
| `/login [provider]` | Add provider authentication |
| `/logout` | Remove provider authentication |
| `/llama` | Manage models on the configured llama.cpp router |

## Sessions and context

| Command | Description |
|---|---|
| `/new` | Start a new session |
| `/resume` | Switch to another saved session |
| `/name [name]` | Set the session display name, or show the current name when omitted |
| `/session` | Show current session information and statistics |
| `/tree` | Navigate the session tree |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current session at its current position |
| `/compact [instructions]` | Compact the current context, optionally with custom instructions |
| `/import <path>` | Import and resume a JSONL session |

## Export and share

| Command | Description |
|---|---|
| `/copy` | Copy the last assistant message |
| `/export [path]` | Export the session as HTML or JSONL |
| `/share` | Upload the session and return a viewer link |
| `/bug [description]` | Prepare a private bug report for the Pi developers |

Review a session before exporting or sharing it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Runtime and project

| Command | Description |
|---|---|
| `/trust` | Save a project trust decision for future Pi processes |
| `/reload` | Reload keybindings, extensions, skills, templates, themes, and context files |
| `/hotkeys` | Show active keyboard shortcuts |
| `/changelog` | Show changelog entries |
| `/quit` | Quit Pi |

## Commands added by resources

| Source | How it appears |
|---|---|
| Extension | Registers commands with their own arguments and completion behavior |
| Prompt template | Under its template name |
| Skill | `/skill:name` when skill commands are enabled |

`/reload` after adding or changing a discovered command resource. Loading and naming: `extensions.md`, `prompt-templates.md`, `skills.md`.
