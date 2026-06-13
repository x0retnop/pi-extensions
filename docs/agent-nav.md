# Agent Navigation — Lost? Start here

This doc is a compass. If you are unsure where something lives or what the rules are, check the tables below before guessing.

## "Where do I look for...?"

| I need to... | Go to |
|---|---|
| Understand dev vs runtime, copy rules, dependencies | `docs/pi-workflow.md` |
| Find ExtensionAPI types, events, tool/command shapes | `docs/pi-quickref.md` |
| Locate Pi's own `.d.ts` files in `node_modules` | `docs/pi-local-map.md` |
| Know what to check after a Pi CLI update | `docs/pi-version-sync.md` |
| Write a new extension from scratch | `docs/creating-extensions.md` |
| Copy-paste boilerplate for tools/commands/TUI | `docs/patterns.md` |
| Read about a specific extension's behavior | `<extension>/README.md` |
| See which extensions are **currently active** | `~/.pi/agent/extensions/` (read-only unless asked) |
| Check gate mode, workspace roots, protected paths | `~/.pi/agent/settings.json` (read-only unless asked) |
| Understand how `permission-gate` works internally | `docs/permission-gate.md` (⚠️ deprecated, extension disabled) |
| Understand how `simple-gate` works | `simple-gate/path-guard.ts` + `simple-gate/index.ts` |
| Find built-in tool limits (read truncation, bash output caps) | `docs/pi-local-map.md` → `dist/core/tools/truncate.js` |
| Read actual implementation of built-in read/bash/edit | `dist/core/tools/*.js` inside Pi install (see `pi-local-map.md`) |

## "What should I remember every session?"

1. **Edit in dev, test after restart.** This repo is `C:/10x001/pi extensions/`. Pi runtime is `~/.pi/agent/extensions/`. Changes only apply after the user copies them and restarts Pi.
2. **SYSTEM.md is empty.** Persona comes from `role-sw` and `~/.pi/agent/roles/`.
3. **AGENTS.md / CLAUDE.md are auto-loaded from `cwd` and all ancestor directories.** Pi walks up the filesystem root and injects every matching file it finds. Use `context-guard` with `ancestor-agents` if you only want the file directly in `cwd`.
4. **Do not edit `~/.pi/agent/` directly** unless the user explicitly says so.

## "Which doc for which task?"

| Task | Doc |
|---|---|
| Fix a false block in the gate | `simple-gate/index.ts` or `permission-gate/docs/permission-gate.md` |
| Add a new command to an extension | `docs/pi-quickref.md` → "Registering a command" |
| Add a new tool to an extension | `docs/pi-quickref.md` → "Registering a tool" |
| Fix a Windows path being mangled in bash | `win-bash-sanitizer/index.ts` |
| Fix a path classified as protected when it should not be | `simple-gate/path-guard.ts` → `looksLikePath()` or `classifyPathAccess()` |
| Update roles or add a new role | `role-sw/README.md`, then create a file in `~/.pi/agent/roles/` (user copies it) |
| Bump supported Pi CLI version | `docs/pi-version-sync.md` → follow the checklist |
