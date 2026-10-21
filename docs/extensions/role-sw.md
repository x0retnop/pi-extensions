# role-sw

Loads a role markdown file from the extension's local `roles/` directory and injects it into the system prompt before every LLM turn.

## What it does

- Reads role files from `role-sw/roles/<role>.md` (next to the extension's `index.ts`).
- **Versioned files are auto-followed.** `agent-core-v4.md` is addressed as `agent-core`; the alias resolves to the highest `-v<N>` on disk, at every read. Drop a new version, delete the old one — no settings edit, no Pi restart (the next agent run re-resolves).
- Resolves `{{include:filename.md}}` directives by loading fragments from the same `roles/` directory.
- Ignores `README.md` and `_*.md` (include/parent fragments) when scanning available roles. `_Sub-agents.md` is filled in by `sub-agents` at the `<!-- sub-agents -->` marker — not via `{{include}}`.
- Replaces the `SYSTEM.md` canary with the role, then the rest of the Pi base prompt (`<project_context>`, cwd, date). Missing/empty role → alarm only.
- Stores the active role **alias** in a custom session entry (`role-switcher`) so it survives reload and `/resume` and keeps following version bumps.
- Caches role files by mtime.

## Versioned role files (family aliases)

A file named `<family>-v<N>.md` belongs to family `<family>`. The `-v<digits>` suffix must be the **last** token (`sub-ds-v4-flash` is a plain name, not a family).

| Stored / typed | Resolves to |
|---|---|
| `agent-core` (alias) | newest `agent-core-v<N>.md` |
| `agent-core-v3` (stale name from an old session or setting) | newest `agent-core-v<N>.md` — versions are never pinned |
| `blank`, `sub-default` (no suffix) | `blank.md`, `sub-default.md` — an exact file wins over versioned siblings |
| unknown family | `null` → role-sw reports the missing role, prompt falls back to the alarm |

Version compare is numeric, so `v10` beats `v9`. **Everything that stores a role name stores the alias** — `settings.roleSwitcher.fixedRole`, `modelRoleMap`, `subAgents.defaultRole`, `agentOverrides.<name>.role`, session entries. A version bump therefore needs no config change anywhere.

The status entry always shows the concrete file (`role:agent-core-v4`), never the alias.

## Model → role mappings

You can bind a model to a role so the role switches automatically when that model is active. Mappings live in `settings.roleSwitcher.modelRoleMap` (`providerId::modelId` → role **alias**).

- **`model_select`**: when the active model *changes*, apply the mapped role (if any).
- **`session_start`**: apply the map only when the session has **no** saved role (new session, or the saved role's whole family was deleted). A role saved in the session (manual `/role` or a previous auto-switch) always wins — it must survive resume/reload.
- **`session_tree`**: when navigating to another branch (`/tree`), restore the role saved in that branch (via `getBranch()`, so sibling branches never leak their role). If the branch has no role record, the current role is kept.
- Unmapped models keep the current role (manual `/role` survives until you switch to a mapped model).

Configure mappings in `/mm` → **Settings** → **Model → role mappings** (pinned favorites only). Or edit `~/.pi/agent/settings.json`:

```json
{
  "roleSwitcher": {
    "modelRoleMap": {
      "openrouter::openai/gpt-4o": "chat",
      "kimi::kimi-k2.7-code": "agent-core"
    }
  }
}
```

The picker lists aliases, so a mapping can never go stale on a version bump.

## Default role modes

`role-sw` can pick the starting role in two ways:

- **Fixed** (default): always start with the configured role alias, e.g. `agent-core` (→ newest version). An empty or no-longer-existing `fixedRole` falls back to the alphabetically first role — `latest` is never consulted in this mode.
- **Smart latest**: on every new session, automatically pick the family of the most recently modified selectable role file in `role-sw/roles/` (`README.md` and `_*.md` skipped). Fallback when nothing resolves: the alphabetically first role.

When a session already has a saved role switch, that role is restored regardless of the default mode. The default mode only applies when no role is stored in the session.

## Important behaviors

- A loaded role forces Pi's custom-prompt path. `promptSnippet` and `promptGuidelines` are then never sent. The model sees the role text plus each tool's JSON schema (`description` and parameter `description`s) — nothing else from the tool registration. Call rules belong in those schema fields. Cross-tool policy belongs in the role. Either fact only in `promptGuidelines` is how guidance silently disappeared (2026-09-16). A role is also not a substitute for schema text: a blank prompt or a different role never sees `agent-core`. Mechanism: `docs/pi-tool-internals.md` §3.
- If the saved role's whole family is missing at restore time, falls back to the mapped role, then the configured default (alias), then the first available role.
- A concrete version in an old session entry (`agent-core-v3`) is normalized to the family, so it follows the bump instead of dying with the deleted file.
- Injection is a replace, not an append. `context-guard`'s `roleOverride` OFF still only strips the legacy `## Role Override (...)` heading — current role files start with `## Role`.
- `~/.pi/agent/SYSTEM.md` must stay non-empty (copy `role-sw/SYSTEM.md`) so Pi takes the customPrompt branch and does not inject its default persona. role-sw strips that canary when a role loads. If role-sw does not load, the model sees only the alarm.
- Circular includes are skipped with an HTML comment marker.
- Missing includes are replaced with an HTML comment marker.
- Sub-agent roles are plain file names by convention (`sub-default` is the hard default for agents without their own role) — `sub-agents` never versions them and the picker lists aliases. If one were versioned (`sub-x-v2.md`), the same family rule applies and it would follow `sub-x-v3.md`.

## State

- `~/.pi/agent/extensions/role-sw/roles/*.md` — role definitions (runtime-only; the repo has no role files), optionally versioned as `<family>-v<N>.md`. `_*.md` are fragments (`_Sub-agents.md` for the parent `/sub` gate), not `/role` entries. Only the newest version of each family is listed; older ones are dead weight (delete them — role-sw only follows, it does not archive). A checked-in copy would be silently overwritten by the next sync, so the dev `roles/` stays empty.
- Custom session entries with `customType: "role-switcher"` store the alias.
- User settings under the `roleSwitcher` key in `~/.pi/agent/settings.json` (`defaultMode`, `fixedRole` alias, `modelRoleMap` aliases).
