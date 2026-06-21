**Task for AI Coding Agent: Implement `pi-model-manager` Extension for Pi Coding Agent**

**Goal**  
Create a clean, fast, keyboard-driven TUI extension that gives the user a single convenient entry point (`/mm`) for managing all providers and models in Pi. The interface must prioritize the user's most important items at the top, allow instant favorite (`*`) toggling without diving into providers, keep providers clearly separated, support per-provider "Use Latest Default vs Remember Last Used" behavior, and provide simple flows for adding/syncing providers and models (especially OpenRouter). The extension must integrate cleanly with Pi's existing `models.json`, `auth.json`, `modelRegistry`, `registerProvider`, and TUI system without breaking anything.

**Language & Style**  
All code, comments, and commit messages in English. Code must be production-quality, minimal, well-structured TypeScript following Pi extension patterns. Use existing Pi APIs and components wherever possible.

**Core Command**  
- Register command `/mm` (and alias `/model-manager`).  
- On execution: open a full custom TUI screen via `ctx.ui.custom(...)` (overlay or main replacement as appropriate).  
- The screen must be scrollable and start with the user's pinned favorites (1–10 items).

**TUI Structure (Hierarchical but Fast)**

**Main Screen (opened by /mm)** — Scrollable list view with these sections in strict order:

1. **Pinned Favorites** (always at top, 1–10 items max)  
   - Shows the most important providers or specific models the user has starred (`*`).  
   - Each row: `[ * ] ProviderName / ModelID — short info (context, reasoning, etc.)`  
   - Inline quick toggle: press `*` or dedicated key to add/remove from favorites instantly.  
   - Goal: user never has to search inside a provider to see what is favorited.

2. **All Managed Providers** (grouped or flat searchable list)  
   - Clear visual separation between providers.  
   - For each provider row: name, auth status, # managed models, current default model, "Use Latest Default" toggle (ON/OFF).  
   - Enter / select a provider → opens **Provider Detail sub-screen**.

3. **Quick Actions** (at the very bottom of the main list, after all providers)  
   - Add New Provider (wizard)  
   - Sync OpenRouter models  
   - Global Settings  
   - Refresh all  
   - Help / Shortcuts

**Provider Detail Sub-Screen** (opened from main list)  
- Breadcrumb: `Providers > OpenRouter`  
- Header with provider toggle: **"Always use newest default model"** (ON = resolve to latest version/alias; OFF = remember last used model for this provider, persisted).  
- Searchable + filterable list of models for this provider.  
- Each model row: checkbox "Managed", star `*` (global favorite), display name, key specs, actions (Edit override, Remove).  
- Bottom actions: "Sync latest from API", "Add custom model", Bulk select.

**Global Settings Screen** (opened from main)  
- Default overall provider  
- Persistence options for last-used models  
- Display preferences

**Key Features & Behavior**

- **Favorites (`*`)**: Global, visible immediately on `/mm` open. Stored separately. Easy add/remove from anywhere (main list or provider detail). Max ~10 to keep list short.
- **Default Model Logic per Provider**:  
  - Toggle "Use Latest Default" (persisted per provider).  
  - When ON: on session start or provider switch, prefer newest model (use Pi `~latest` aliases or highest version if available).  
  - When OFF: remember and restore last used model for that provider (use `pi.appendEntry` + file persistence).
- **Adding Providers**:
  - Hybrid flow: "Add via existing /login" (guides user, detects new auth.json entry, offers configuration).  
  - Direct custom provider form in TUI (name, baseUrl, apiKey with $VAR support, api type).  
  - Special fast path for OpenRouter: "Sync from OpenRouter" → fetch `/v1/models`, multi-select, add only chosen ones to curated/managed list + optional routing overrides.
- **Curated View**: When user enables models for a provider, the extension can dynamically call `pi.registerProvider(...)` with a filtered `models: [...]` array so only managed models appear in normal `/model` and `Ctrl+L`.
- **Persistence**: Store extension config in `~/.pi/agent/model-manager.json` (separate from Pi's `models.json`). Merge on load with built-in providers + `models.json` overrides.
- **Keyboard UX**: Full keyboard navigation, `*` for favorite toggle, Enter to enter subview, Esc/q to go back, `/` for search, `?` for help. Use existing Pi keybinding patterns.
- **Performance**: Lazy load model lists. Cache OpenRouter responses. Fast startup.

**Data Model (suggested)**

```ts
interface ManagedProvider {
  id: string;                    // "openrouter", "kimi", etc.
  enabled: boolean;
  useLatestDefault: boolean;
  lastUsedModel?: string;
  managedModelIds: string[];     // only these are shown/curated
  overrides?: Record<string, ModelOverride>;
}

interface ModelOverride {
  displayName?: string;
  // routing, cost, context, etc.
}

interface Favorites {
  items: Array<{ providerId: string; modelId?: string }>; // modelId optional = whole provider
}
```

**File & Package Structure (recommended)**

```
~/.pi/agent/extensions/model-manager/
├── index.ts                 # main entry, registerCommand, on("session_start")
├── types.ts
├── config.ts                # load/save model-manager.json, merge logic
├── ui/
│   ├── main-screen.ts       # root list with Favorites + Providers
│   ├── provider-detail.ts   # sub-screen
│   ├── settings.ts
│   └── components/          # reusable list rows, toggles
├── openrouter.ts            # sync logic, fetch models
├── provider-utils.ts        # register/unregister curated providers, default resolution
├── persistence.ts
└── package.json (if needed for extra deps)
```

**Implementation Order for the Agent (do in this sequence)**

1. Create folder structure + basic `index.ts` that registers `/mm` command and opens empty `ui.custom` placeholder.
2. Implement config persistence (`model-manager.json`).
3. Build main screen list using `SettingsList` or `SelectList` + custom rows (study `tools.ts` example).
4. Add Favorites section + `*` toggle (global, visible on open).
5. Implement provider detail sub-screen + "Use Latest Default" toggle + model list.
6. Add OpenRouter sync functionality (fetch + multi-select).
7. Add "Add Provider" flows (hybrid /login + custom form).
8. Wire default model logic + last-used persistence + dynamic `registerProvider` for curated views.
9. Polish: search, filters, keyboard shortcuts, breadcrumbs, help overlay, status line.
10. Test integration: does not break normal `/model`, `Ctrl+L`, existing providers, `models.json` overrides.

**Critical Pi APIs & Files the Agent Must Study (read these first)**

- `packages/coding-agent/examples/extensions/tools.ts` — best example of `SettingsList` + interactive toggles + `ui.custom`.
- `packages/coding-agent/examples/extensions/preset.ts` — command + state + UI.
- `packages/coding-agent/examples/extensions/model-status.ts` — `on("model_select")`.
- `packages/coding-agent/examples/extensions/custom-provider-anthropic/` and similar — `pi.registerProvider()` patterns.
- Official docs:  
  - https://pi.dev/docs/latest/extensions (especially `ui.custom`, `registerCommand`, events, `ctx.modelRegistry`)
  - https://pi.dev/docs/latest/tui (SettingsList, SelectList, Container, etc.)
  - https://pi.dev/docs/latest/models and custom-provider.md
- `pi.setModel()`, `pi.registerProvider(name, {models: [...]})`, `pi.unregisterProvider()`, `ctx.ui.*`, `pi.appendEntry()`.
- How Pi loads `auth.json` and `models.json` (look in model registry / auth storage code).

**Non-Functional Requirements**
- Minimal dependencies.
- Clean separation: UI vs logic vs persistence.
- Graceful fallback if not in TUI mode.
- Idempotent registration.
- Good error handling and user notifications via `ctx.ui.notify`.
- Do not modify user's existing `models.json` unless explicitly asked (prefer separate config + dynamic registerProvider overrides).

**Deliverables**
- Complete working extension code in the folder structure above.
- Short README.md inside the extension explaining `/mm` usage and key shortcuts.
- One example `model-manager.json` with sensible defaults (user can edit favorites and toggles manually if needed).

**Success Criteria**
- `/mm` opens instantly to a clean scrollable list starting with favorites.
- User can star/unstar items in < 2 keystrokes without entering provider sub-menus.
- Providers are clearly separated.
- "Use Latest Default" toggle works as described.
- Adding/syncing OpenRouter feels fast and natural.
- Extension feels native to Pi (same keyboard feel, same components).

Implement this step by step. After each major screen/feature, describe what was done and what the user can test next. Use existing Pi patterns heavily. Ask clarifying questions only if a critical decision cannot be made from the spec above.

Start now. First output: confirm you have read the key example files and docs, then begin with step 1 (basic command + placeholder screen).