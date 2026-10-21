# CLI
> Adapted from bundled docs `cli.md`, `cli-integration.md` (Pi 1.0.1; the installed package wins if they disagree).

## CLI reference

Built-in commands and options. `pi --help`, or `--help` appended to a command, is the exact interface for the installed version. Top-level help includes options registered by loaded extensions.

```sh
pi [options] [--] [@files...] [messages...]
pi install <source> [options]
pi remove <source> [options]
pi uninstall <source> [options]
pi update [target] [options]
pi list
pi config [options]
pi auth <check|print-api-key|print-bearer-token> [options]
pi mcp <list|login|logout> [options]
```

### Invocation and output

Terminal stdin and stdout open the terminal UI unless `--print`, `--mode json`, or `--mode rpc` selects another interface. If either stream is redirected and neither JSON nor RPC is selected, Pi uses print mode. `--print` controls whether Pi runs once and exits. `--mode` selects the output interface. `--mode text` does not force one-shot execution when stdin and stdout are terminals; use `--print` for that.

The cwd resolves `@path` and controls project configuration, resource discovery, and session grouping.

| Input | Behavior |
|---|---|
| `message` | Initial prompt |
| `@path` | Include a text file or image in the first prompt |
| Piped stdin | Prepend its contents to the first prompt |
| `--` | Stop option parsing so a prompt can begin with `-` |

| Option | Behavior |
|---|---|
| `-p`, `--print` | Run the supplied prompts, write the final assistant text to stdout, then exit |
| `--mode text` | Text output. Still opens the terminal UI when stdin and stdout are terminals |
| `--mode json` | Run the supplied prompts, write JSONL events to stdout, then exit |
| `--mode rpc` | Read JSONL commands from stdin. Write responses and events to stdout until shutdown |
| `--export <input> [output]` | Export a session file to HTML and exit. Destination is derived when `output` is omitted |

RPC mode rejects `@file` arguments. JSON and RPC modes reserve stdout for protocol records. Event shapes: `json.md`. RPC protocol: `rpc.md`. Mode choice: CLI integration below.

### Models

| Option | Behavior |
|---|---|
| `--provider <name>` | Restrict `--model` lookup to one provider. Requires `--model` |
| `--model <pattern>` | Exact ID, or fuzzy ID/name match. Accepts `provider/id` and an optional `:<thinking>` suffix |
| `--api-key <key>` | Non-persistent API-key override. Requires a model selected through `--model` or `--models` |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Overrides a `--model` suffix. Clamped to the model's capabilities |
| `--models <patterns>` | Comma-separated scope for startup and cycling. Exact IDs, fuzzy matches, case-insensitive globs, optional `:<thinking>` suffixes |
| `--list-models [search]` | List available models, optionally filtered by a fuzzy search, then exit |

Selection: `models.md`. Credentials: `providers.md`.

### Sessions

| Option | Behavior |
|---|---|
| `-c`, `--continue` | Continue the most recent session for the current project |
| `-r`, `--resume` | Open the session selector |
| `--session <path\|id>` | Open by file path, exact ID, or partial ID. Searches the current project first and offers to fork a cross-project match |
| `--session-id <id>` | Open the exact project session ID, or create it if absent. IDs accept letters, numbers, `.`, `_`, and `-` |
| `--fork <path\|id>` | Fork an existing session into a new session for the current project |
| `--session-dir <dir>` | Override storage and lookup. Takes precedence over `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting |
| `--no-session` | In-memory session. Not persisted |
| `-n`, `--name <name>` | Session display name |

| Constraint | Rule |
|---|---|
| Session IDs | Must start and end with a letter or number |
| `--fork` | Cannot combine with `--session`, `--continue`, `--resume`, or `--no-session` |
| `--session-id` | Cannot combine with `--session`, `--continue`, or `--resume`. Combine with `--fork` to choose the new ID |

Resuming, forking, naming, storage: `sessions.md`.

### Tools

| Option | Behavior |
|---|---|
| `-t`, `--tools <list>` | Replace the default selection with a comma-separated allowlist of built-in, extension, or custom tools |
| `-xt`, `--exclude-tools <list>` | Disable comma-separated tool names after all other selection options |
| `-nbt`, `--no-builtin-tools` | Disable default built-in tools. Extension and custom tools remain |
| `-nt`, `--no-tools` | Start with all built-in, extension, and custom tools disabled |

Default enabled tools are `read`, `bash`, `edit`, and `write`, unless `defaultTools` changes them. `--tools` replaces the whole selection, so name every tool. `defaultTools` also accepts `+name` and `-name`. Default selection: `settings.md`.

| Built-in | Purpose |
|---|---|
| `read` | Read text files and supported images |
| `bash` | Run shell commands |
| `powershell` | Run PowerShell commands on Windows |
| `edit` | Exact text replacements in an existing file |
| `write` | Create or overwrite a file |
| `grep` | Search file contents |
| `find` | Find paths by glob |
| `ls` | List directory contents |

Built-in extensions add two more tools. Off by default. The MCP extension turns them on when an MCP server needs them (`mcp.md`, Exposure). Name them in `--tools` or `defaultTools` to enable them.

| Tool | Purpose |
|---|---|
| `codemode` | JavaScript that calls the other tools, for example in parallel with `Promise.allSettled`. Only the script's output reaches the model |
| `tool_search` | Search tools not declared to the model (`codemode` and `deferred` exposure, such as MCP tools) and declare the matches for the next call |

#### Enable codemode

Every session: `~/.pi/agent/settings.json` or a project's `.pi/settings.json`. This keeps `read`, `bash`, `edit`, and `write` and adds `codemode`.

```json
{
  "defaultTools": ["+codemode"]
}
```

One invocation must list every tool, because `--tools` replaces the selection:

```sh
pi --tools read,bash,edit,write,codemode
```

Useful without MCP: scripts can run several tool calls in parallel, filter large output before it reaches the model, call classifier models such as TypeSafe's Jev through `models.classify()` (`models.md`, Classifier models), and generate images through `models.generateImages()` (`models.md`, Image models).

#### How codemode works

Scripts run in a QuickJS sandbox and call other tools through `tools.<name>(args)`. Script API, listing and finding tools, `store()`, `models` globals, and limits: `codemode.md`.

#### Tool search

Off by default. Enable with `"defaultTools": ["+tool_search"]` or `--tools`. Same ranking as `searchTools()` over tools not declared yet; declares the matches for the next model call. Loaded tools are recorded in the session like other tool changes, so they stay declared on that branch.

### Resources

Paths apply only to the current process. Relative paths resolve from the cwd.

| Option | Behavior |
|---|---|
| `-e`, `--extension <path>` | Load an extension file or directory, or a built-in such as `builtin:mcp`. Repeatable |
| `-ne`, `--no-extensions` | Disable discovered, configured, and built-in extensions. Explicit `-e` still loads. `pi -ne -e builtin:mcp` keeps only built-in MCP |
| `--skill <path>` | Load a skill file or directory. Repeatable |
| `-ns`, `--no-skills` | Disable discovered and configured skills. Explicit `--skill` still loads |
| `--prompt-template <path>` | Load a prompt-template file or directory. Repeatable |
| `-np`, `--no-prompt-templates` | Disable discovered and configured templates. Explicit `--prompt-template` still loads |
| `--theme <path>` | Load a theme file or directory. Repeatable |
| `--use-theme <name[/name]>` | Initial interactive theme for this run |
| `--no-themes` | Disable discovered and configured themes. Explicit `--theme` still loads |
| `-nc`, `--no-context-files` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Directories and trust: `configuration.md`. Configured paths: `settings.md`. Package sources: `packages.md`.

### Prompts and process

| Option | Behavior |
|---|---|
| `--system-prompt <text\|path>` | Replace the default system prompt with text, or the contents of an existing file |
| `--append-system-prompt <text\|path>` | Append text or an existing file. Repeatable |
| `--tui-mode <mode>` | `fullscreen` (default) or `regular` |
| `--verbose` | Verbose interactive startup information. Overrides `quietStartup` |
| `-a`, `--approve` | Trust project-local configuration and resources for this process |
| `-na`, `--no-approve` | Ignore trust-gated project-local configuration and resources for this process |
| `--offline` | Disable automatic network activity, including model catalog refreshes. Equivalent to `PI_OFFLINE=1` |
| `-h`, `--help` | Show help, including flags registered by loaded extensions, then exit |
| `-v`, `--version` | Show the Pi version, then exit |

Extensions may register additional long-form options. Unknown short options are rejected.

Saved configuration: `configuration.md`. Project trust: `security.md`. Process controls: `environment-variables.md`.

### Package commands

#### Common tasks

| Task | Command |
|---|---|
| Install a package | `pi install <source>` |
| List configured packages | `pi list` |
| Remove a package and its settings entry | `pi remove <source>` |
| Configure which package resources load | `pi config` |

`--local` or `-l` on `install`, `remove`, `uninstall`, or `config` uses project settings instead of global settings. Example: `pi install npm:@scope/package`. Source formats, filtering, installation, project scope: `packages.md`.

#### Update Pi or packages

`pi update` with no target updates Pi itself.

| Task | Command |
|---|---|
| Update Pi | `pi update` |
| Update all installed packages | `pi update --extensions` |
| Update one installed package | `pi update <source>` |
| Refresh model catalogs | `pi update --models` |
| Update Pi and all installed packages | `pi update --all` |

`--force` reinstalls Pi when the selected update includes Pi.

`pi update` cannot update Pi when another package manager provides it, such as Nix (`nix profile upgrade pi`). Package and model catalog updates still work.

#### Aliases and command options

| Alias | Equivalent |
|---|---|
| `pi uninstall <source>` | `pi remove <source>` |
| `pi update --self` | `pi update` |
| `pi update self` | `pi update` |
| `pi update pi` | `pi update` |
| `pi update --extension <source>` | `pi update <source>` |

`-a`, `--approve` trusts project-local files for one command. `-na`, `--no-approve` ignores trust-gated project-local files. Append `-h` or `--help` to a command for its exact usage and option constraints.

### Credential commands

Require `--provider <provider>` or `--model <model>`. Credential-printing commands write secrets to stdout. Methods: `providers.md`.

```sh
pi auth check --provider openai --json
```

| Command | Result |
|---|---|
| `pi auth check` | Print `ready`, `not_ready`, or `invalid`. Exit status `0`, `1`, or `2` |
| `pi auth print-api-key` | Print the resolved API key |
| `pi auth print-bearer-token` | Print a resolved OAuth bearer token |

| Option | Applies to | Behavior |
|---|---|---|
| `--provider <provider>` | All | Resolve credentials for a provider |
| `--model <model>` | All | Resolve credentials from a model. May be combined with `--provider` |
| `--json` | `auth check` | Write the structured result as JSON |
| `--credentials` | `auth check` | Emit the resolved credential when ready |
| `--no-refresh` | `auth check` | Do not refresh expired OAuth credentials. Refresh is the default |
| `--min-expiry <duration>` | `print-bearer-token` | Require remaining lifetime. Units `ms`, `s`, `m`, `h` (example `30m`) |

### MCP commands

Work outside a session, so agents can run them through `bash`. `add` and `remove` change `~/.pi/agent/mcp.json`, or `.pi/mcp.json` in the cwd with `--local` (`-l`). `add` does not connect; run `pi mcp list` to check the server. Project `.pi/mcp.json` is only read for projects that are already trusted. Servers: `mcp.md`.

| Command | Behavior |
|---|---|
| `pi mcp add <server> [options] -- <command> [args...]` | Add or replace a stdio server in `mcp.json`. Arguments after the command are passed to it |
| `pi mcp add <server> [options] --url <url>` | Add or replace a streamable HTTP server |
| `pi mcp remove <server>` | Remove a server from `mcp.json`. Stored OAuth credentials are kept |
| `pi mcp list [--json]` | Connect to every enabled server and print state, tools, and errors. Exit `1` if a config entry is invalid or an enabled server is not connected |
| `pi mcp login <server> [--timeout <seconds>]` | OAuth sign-in. Opens the authorization page and waits for the browser (default 300 seconds). A terminal also accepts the pasted redirect URL |
| `pi mcp logout <server>` | Delete the stored OAuth credentials of a server |

| Flag | Use |
|---|---|
| `--env KEY=VALUE` | stdio `add`. Repeatable. Environment |
| `--cwd <dir>` | stdio `add`. Working directory |
| `--url <url>` | HTTP `add` |
| `--header KEY=VALUE` | HTTP `add`. Repeatable |
| `--bearer-token-env-var <NAME>` | HTTP `add`. Sends `Authorization: Bearer ${NAME}` |
| `--oauth-client-id` | HTTP `add` |
| `--oauth-client-secret` | HTTP `add` |
| `--oauth-callback-port` | HTTP `add` |
| `--oauth-client-name` | HTTP `add` |
| `--exposure <mode>` | `add`. See `mcp.md` (Exposure) |
| `--description <text>` | `add` |
| `--json` | `list` |
| `--timeout <seconds>` | `login`. Default 300 |
| `--local`, `-l` | `add` and `remove`. Write `.pi/mcp.json` instead of `~/.pi/agent/mcp.json` |

## CLI integration

Default `pi` opens the interactive terminal UI. Piped or redirected input or output selects print mode. Print, JSON, or RPC can also be selected explicitly. All four modes use the same agent, sessions, resources, and tools. The mode sets how input enters, how output is exposed, and whether the process stays up for more commands.

CLI options still select cwd, model, tools, resources, and session persistence independently of the mode.

The SDK is not a CLI mode. It embeds the agent in a Node.js or Bun process (`sdk.md`).

### Choose a mode

| Mode | Interface | Lifetime | Use when |
|---|---|---|---|
| Interactive | Terminal UI | Until the user exits | A person is working with Pi directly |
| Print | Final text on stdout | One invocation | A script needs the final assistant response |
| JSON | JSONL events on stdout | One invocation | A process needs structured progress from a run |
| RPC | JSONL commands, responses, and events | Long-lived | A process needs bidirectional control |

### Print to stdout

Runs the supplied prompts, writes the final assistant text to stdout, and exits. Intermediate events are not exposed. Use when only the final text is needed, including command substitution, pipelines, and one-shot jobs. Errors go to stderr. A final assistant response with stop reason `error` or `aborted` exits nonzero.

When no mode is selected explicitly, non-TTY stdin or stdout also selects print mode, so pipes work without `--print`.

### Stream JSON events

A session header, then agent and session events, as newline-delimited JSON. Structured event output: not one JSON result, and not a constraint on the model's response format. All prompts are supplied at start. The process streams that run and exits. It does not accept later commands.

| Case | Behavior |
|---|---|
| Failed or aborted assistant | In the event stream. Does not by itself exit nonzero. Inspect events when success matters. Nonzero if the invocation throws |
| `message_update` | Deltas, not a growing snapshot. Assemble from the deltas, then replace with the message from `message_end` |
| `agent_end` | May be followed by automatic recovery or queued work |
| `agent_settled` | End of automatic work for the current run |
| stdout | Reserved for JSONL. Diagnostics and application logging go to stderr |

Framing, shapes, reconstruction: `json.md`.

### Control Pi with RPC

```sh
pi --mode rpc --no-session
```

Commands are JSON objects on stdin. Responses and events are JSON objects on stdout. One record per line.

| Rule | Behavior |
|---|---|
| `id` | Put on commands that need correlation. The matching response repeats that `id`. Events generally have no command ID (session activity, not one request) |
| `prompt` response | Accepted, queued, or handled. Not completion. Keep reading through `agent_settled` when completion matters |
| Command scope | Change models, inspect state, manage sessions, run shell commands, answer extension UI requests |
| Extension dialogs | Request-response subprotocol (`rpc-extension-ui.md`) |
| Other extension UI | Notifications. A client may display or ignore them |
| TUI-only extension capabilities | Unavailable or degraded outside interactive mode |

Node.js or TypeScript: prefer `RpcClient` from `@earendil-works/pi-coding-agent`. It starts a Pi RPC child, correlates requests, exposes typed command methods, and delivers session events to listeners. It needs a path to a runnable Pi CLI. `examples/rpc-client.ts` points at `dist/cli.js`, so the package must be built before that example runs from a checkout. The example sends one prompt, streams text and tool activity, waits for `agent_settled`, and shuts down the child. It is included in the repository's TypeScript checks.

| Method | Semantics |
|---|---|
| `RpcClient.promptAndWait()` | Installs its event listener before sending the prompt, avoiding a race with fast completions |
| `RpcClient.prompt()` | For separate operations, subscribe before calling |
| `RpcClient.waitForIdle()` | Call only while a run is active |

Without `RpcClient`, start with `rpc.md`, then `rpc-commands.md` and `json.md`.

### Fork and rebrand Pi

A source fork sets the CLI name and configuration directory in `package.json`. The top-level `bin` field sets the executable name. These settings affect the CLI banner, configuration paths, and derived environment variable names.

```json
{
  "piConfig": {
    "name": "my-agent",
    "configDir": ".my-agent"
  }
}
```

### Examples and references

| Reference | Contents |
|---|---|
| `examples/rpc-client.ts` | Typed Node.js integration |
| `examples/rpc-extension-ui.ts` | Custom terminal client with extension dialogs |
| `examples/sdk/` | In-process TypeScript integrations |
| `json.md` | JSON event reference |
| `rpc.md` | RPC lifecycle, framing, errors, shutdown |
| `rpc-commands.md` | Command and response reference |
| `rpc-extension-ui.md` | Extension interaction subprotocol |
