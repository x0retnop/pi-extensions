# Creating Extensions for This Collection

Minimal guide for adding a new Pi extension to this repo.

## Package shape

One folder = one standalone Pi package.

```text
my-extension/
  index.ts      # entry point: default export function (pi: ExtensionAPI)
  package.json  # name, type: module, pi.extensions, peerDependencies
  README.md     # short public description (what it does, install, commands/tools)
```

If the extension is large enough to split, keep it flat:

```text
my-extension/
  index.ts
  config.ts
  types.ts
  utils.ts
  package.json
  README.md
```

## Naming

Use `pi-extension-<name>` for the npm package name.

## package.json template

```json
{
  "name": "pi-extension-my-thing",
  "version": "0.1.0",
  "description": "One-line summary",
  "type": "module",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

Add `@earendil-works/pi-ai` and `@earendil-works/pi-tui` to `peerDependencies` only if you import from them.

## index.ts template

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What it does.",
    parameters: Type.Object({
      path: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Result for ${params.path}` }],
        details: {},
      };
    },
  });

  pi.registerCommand("mycommand", {
    description: "Do something",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello", "info");
    },
  });
}
```

## README template

Keep it under ~30 lines unless the tool has complex keybindings or behavior:

```markdown
# My Extension

What it does in one sentence.

## Install

```bash
pi install ./my-extension
```

## Features

- `my_tool` — model-callable tool that does X.
- `/mycommand` — slash command that does Y.
```

## Local install / test

```bash
# from the repo root
pi install ./my-extension
```

Then `/reload` or restart Pi.

## Type-check

```bash
# from the repo root
npx --no-install tsc --noEmit
```

## Style rules

- One extension = one folder.
- Code, `package.json`, and a short `README.md` only.
- No marketing prose, no long architecture essays, no big examples unless necessary.
- Do not bundle Pi core packages. Keep them as `peerDependencies`.
- Do not add tests, build scripts, or lock files unless the task explicitly asks for them.
- Keep UI messages concise and consistent with the existing style.

## When to update docs

- Adding a new ready extension → update the root `README.md` catalog.
- Changing a public command, tool, or install flow → update that extension's `README.md`.
- Internal refactoring with no user-facing change → usually skip README updates.
