# Pi Upgrade 0.79.10 → 0.80.7 — Notes for Agents

Condensed, verified findings for this extension collection. Audience: LLM agents working in this repo. Source: upstream CHANGELOG (fetched 2026-07-14) + local inspection.

## Verdict

Safe upgrade. One-line code fix required (`getProviders` import), no behavior breakage. Dev deps in this repo were bumped 0.79.6 → 0.80.7; `npm run typecheck` is clean.

## Breaking / risk items

| Change | Impact here | Status |
|---|---|---|
| pi-ai old global API moved root → `/compat` (0.80.0). Runtime loader aliases root → compat, so extensions keep working at runtime; typecheck against 0.80.x types fails on removed root exports | `model-manager/provider-utils.ts` imported `getProviders` from root | **Fixed**: import switched to `@earendil-works/pi-ai/compat`. Other pi-ai imports (`StringEnum`, types) still on root — valid |
| `pi-ai/base` and `pi-agent-core/base` entrypoints removed (0.80.0) | Not used anywhere in the repo | No action |
| `compat.sendSessionIdHeader` removed → `compat.sessionAffinityFormat` (0.80.7) | Not used in repo, `settings.json`, or `models.json` | No action |
| `/compat` entrypoint + loader alias will be removed in a future release | One import uses it now | Track at next upgrades; long-term migrate to `Models`/provider-factory API |

## New features worth knowing (most relevant first)

### Extension API

- **Entry renderers (0.80.4)** — `pi.appendEntry(customType, data)` + `pi.registerEntryRenderer(customType, (entry, {expanded}, theme) => Component | undefined)`. Persisted, **display-only** entries rendered inline in the transcript in session order, restored on `/resume`, never sent to the model. `expanded` follows the global Ctrl+O toggle. Renderer exceptions are caught by the host. Use for: status cards, progress, timestamps, audit rows. Already used by `tool-timestamps` v3 (inline mode).
- **Dynamic tool loading (0.80.7)** — tools added by extensions mid-run (via tool results) now load definitions where they become available, **preserving the Anthropic/OpenAI-Responses prompt-cache prefix**. Relevant to `context-guard` tool toggling: fewer cache-busting tool-set changes; re-evaluate its toggle strategy if it was shaped around cache loss.
- **`agent_settled` event + idle waiting (0.80.4)** — fires when the agent run is fully settled (queued steers/follow-ups done), unlike `agent_end`. Use for automation that must wait for true idle (`sub-agents`, RPC drivers).
- **`before_provider_headers` hook (0.80.4)** — inject provider request headers per request. Use for proxy/auth tagging; keep away from cache-sensitive headers.
- **`session_info_changed` event (0.80.3)** — observe session renames.
- **`InlineExtension` type (0.80.4)** — named inline extension factories for SDK/embedding; not needed by file-based extensions here.
- **RPC (0.80.3)**: `get_entries` / `get_tree` commands; `./rpc-entry` package export for direct RPC-mode launch.

### UI / settings

- **`showCacheMissNotices` setting + `/settings` toggle (0.80.4)** — transcript notices on significant prompt-cache misses (states facts: miss, model switch, idle past TTL). Not persisted; re-derived from entries on rebuild. **Recommend enabling** — complements `strip-cache-retention`: the extension intentionally alters `cache_control`, and the notices show the resulting real cache behavior.
- **`Ctrl+X` (0.80.7)** — copies last assistant message (or selected message in `/tree`). No conflicts with registered extension shortcuts here.
- **`outputPad` setting (0.80.3)** — horizontal padding of user/assistant/thinking blocks. Tune to taste (reduce if transcript feels wide).
- **`externalEditor` setting (0.80.3)** — Ctrl+G editor override; defaults to Notepad on Windows. Set if Ctrl+G is used.
- **`pi config -l` (0.80.4)** — manage global vs project-local package resources, Tab to switch scopes.

### Models / providers

- **`max` thinking level (0.80.6, opt-in)** — above `xhigh`; CLI `--thinking max`, SDK/RPC, model selection. Themes can define `thinkingMax` (existing themes fall back to `thinkingXhigh` — `themes/dark-clean-code.json` has it, fine). Model-manager: no hardcoded level lists found, no action.
- **Input-token pricing tiers (0.80.6)** — request-wide tiers for long-context pricing; configurable in `models.json`, `modelOverrides`, extension-registered providers. Relevant if model-manager registers custom GPT-5.x long-context models.
- **Fable 5 `xhigh`/`max` levels (0.80.7)**, GPT-5.6 metadata, Copilot Sonnet 5, zstd Codex SSE transport (0.80.4).
- **`~` expansion for `shellPath` (0.80.6)**.

### Behavior changes to be aware of

- **Current date removed from the default system prompt (0.80.7)** — fixes cross-day cache invalidation, but agents no longer know "today" from the prompt. If a workflow needs the date, inject it (`before_agent_start`) or accept date-less prompts. `tool-timestamps` makes wall-clock visible to the user but not to the model.
- **Startup AGENTS.md discovery hang on Windows fixed (0.80.4)** — parent traversal is now stable; relevant to this repo's nested-context setup.
- **Edit tool schema tolerates model-invented extra fields (0.80.7→0.80.4)** — fewer spurious edit rejections; `pi-multi-edit` behavior unchanged.
- **Compaction budgeting counts context-visible custom messages (0.80.4)** — only relevant if `pi.sendMessage` is used heavily; entry-rendered data does NOT count (not in context).

## Done as part of this upgrade

- Repo dev deps bumped to 0.80.7 (`package-lock.json`).
- `model-manager/provider-utils.ts`: `getProviders` import → `@earendil-works/pi-ai/compat`.
- `npm run typecheck` clean; unit tests 65/68 (3 failures are pre-existing uncommitted `pi-multi-edit` WIP, verified via stash — not upgrade-related).
- `docs/pi-version-sync.md` baseline raised 0.77.0 → 0.80.7.

## Worth doing later (candidates, not required)

1. Enable `showCacheMissNotices` and observe for a week; decide whether `strip-cache-retention` needs tuning.
2. Re-evaluate `context-guard` tool-toggle strategy against cache-friendly dynamic tool loading.
3. Migrate `model-manager` off `/compat` to the new `Models` provider-factory API when it stabilizes.
4. Optional: set `externalEditor` (Windows default is Notepad).
5. Optional: try `--thinking max` on supported models; add `thinkingMax` to custom themes if desired.

## Smoke checklist for interactive use

- [ ] Start Pi, confirm no extension load errors (0.80.0 improved crash reporting; `pi -ne` isolates extensions).
- [ ] `/resume` an old session — transcript renders fine (no inline timestamps expected there, see `tool-timestamps` README).
- [ ] Run one tool from each overridden tool: `read`, `grep`, `edit` (read-mode, grep-tool, pi-multi-edit).
- [ ] `model-manager`: open UI, cycle thinking level once.
- [ ] `tool-timestamps`: run a couple of tools, confirm inline dim rows under tool calls; Ctrl+O expands snippet; `/timestamps all` opens the full list.
