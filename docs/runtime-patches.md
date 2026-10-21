# Pi runtime patches (host-local)

Patches applied to the **global npm install** of `@earendil-works/pi-coding-agent`, not to this repo.
`npm i -g …` wipes all of them; after every upgrade re-apply from here.

**State: pi 1.0.1** (upgraded 2026-10-03; P-9 added 2026-10-04, P-10 2026-10-05). Two sites are settings, not code:
P-1 → `fullscreenWheelScrollLines`, P-5 site 1 → `fullscreenCopyOnSelect`.

## Where the code lives (1.0.1)

1. **Live:** the CLI loads `dist/bundle/cli.js` (a shim: `enableCompileCache()` + `require("./cli-runtime.js")`)
   → `dist/bundle/cli-runtime.js` → **15 eager chunks**. The eager cost is split now, no longer one chunk:
   `chunk-5OEJBNHG.js` 2624 KB (core, system prompt, catalog, resources), `chunk-6FX7UEPL.js` 472 KB
   (TUI incl. `TuiAltScreen`), `chunk-SYF2TF6W.js` 211 KB, `chunk-S3GGRYIO.js` 109 KB,
   `chunk-PDFMCAOZ.js` 103 KB, plus 10 small ones. Chunk hashes change every release — grep by content.
2. **Modular mirror:** `dist/**` and the nested `node_modules/@earendil-works/pi-tui/dist/**`. Not what
   `pi` executes, but runnable (`node dist/cli.js`, verified) and kept in sync so the patch registry
   stays readable and a modular launch stays an option.

Patch tool: `scripts/pi_runtime_patches.py` (check by default, `--apply` to write). It asserts every
anchor, is idempotent, writes `*.backup-<ts>-hostpatch` per touched file, and reports FAIL instead of
guessing when an anchor moved in a new release. Anchors are written for 1.0.1.

Backups present after this upgrade:
`*.backup-20261003-183455-hostpatch` = stock 1.0.1 for every file the script edited;
`chunk-5OEJBNHG.js.backup-20261003-183404-decat` = stock 1.0.1 chunk before P-6;
`*.backup-20261004-182410-hostpatch` = the P-9 files — the core-chunk copy already carries P-2/P-3/P-4,
it is **not** stock 1.0.1; the P-10 backup of the core chunk additionally carries P-9.
The 0.84.4 patched-chunk copies kept during this upgrade were scratch and are deleted; a 0.84.4
runtime comes back from npm (`npm i -g …@0.84.4`) plus a re-apply.

**Never** restore a previous-version `*.backup-*` over a newer file. Rollback = `npm i -g …@<version>`
plus a re-apply, or `--revert` for P-6 alone.

`fullscreenCopyOnSelect` (0.84.4) is the setting that retires P-5 site 1 — the host sets it `false`.
`fullscreenWheelScrollLines` (0.99.0) retires P-1 — the host sets it `3`.

---

## P-1: Fullscreen mouse-wheel step 3 lines per notch — RETIRED (setting)

**Status: RETIRED 2026-10-03** — upstream added `fullscreenWheelScrollLines` in 0.99.0
(`"auto"` default, 1–100, Alt+wheel = ×5). Host `~/.pi/agent/settings.json`:
`"fullscreenWheelScrollLines": 3`, which reproduces the pre-0.84 feel without a patch.
Verify: `rg -F '"fullscreenWheelScrollLines": 3' ~/.pi/agent/settings.json` (and `/settings` shows it).
Do not re-apply the old `wheelScrollLines: 3` option edit while this setting is present.

---

## P-2: Remote catalog overlay must not drop client-local model fields

**Status: ACTIVE** (re-applied 2026-10-03, pi 1.0.1) — robustness only

- **Problem**: `mergeModels` keys models by `type\0id` and lets the later (pi.dev catalog) entry
  overwrite the baseline model wholesale, dropping baseline-only fields (`headers`, and anything else
  only the built-in ships).
- **Fix**: merge instead of replace when the key already exists.
- **Live**: `dist/bundle/chunks/chunk-5OEJBNHG.js` —
  `merged.set(_pk,_pv?{..._pv,...model}/*P-2*/:model)`. Modular: `dist/core/remote-catalog-provider.js`.
- **Hashes (sha256)**: stock chunk `a760f30e4768230e7ed248fbbe97840a9039123aac093178476341fafa60d741`
  (= the `-decat` backup); patched chunk `355df29dec5f2c05e5a9ffb016dcf21252cc2cc9a16ad5301ed8a9d5c6adc361`.
- **Verify**: `rg -F "/*P-2*/" dist/bundle/chunks`; `node --check` the chunk.

---

## P-3: Do not load AGENTS.md / CLAUDE.md into the system prompt

**Status: ACTIVE** (re-applied 2026-10-03, pi 1.0.1)

- **Problem**: stock Pi walks cwd → FS root (plus the agent dir) and glues every `AGENTS.md` /
  `CLAUDE.md` into `<project_context>` on every rebuild. This host wants that file as a one-shot first
  message (context-guard `agentsInject`), not standing system text.
- **Fix**: `loadProjectContextFiles()` returns `[]` immediately; discovery, ancestor walk and
  `AGENTS.override.md` stay dead code. Still no upstream equivalent in 1.0.1 (checked `docs/settings.md`).
- **Live**: `chunk-5OEJBNHG.js` — `function loadProjectContextFiles(options){return[];/*P-3*/…`.
  Modular: `dist/core/resource-loader.js`.
- **Verify**: `rg -F "/*P-3*/" dist/bundle/chunks`; after a restart, `inspect` shows no `[AGENTS.md]`
  in the system prompt.

---

## P-4: Do not append `<available_skills>`

**Status: ACTIVE** (re-applied 2026-10-03, pi 1.0.1)

- **Problem**: `buildSystemPrompt` sets `promptSections.skills = formatSkillsForPrompt(...)` whenever
  skills are loaded and `read`/`bash` is selected. This host uses `/use-skill` (context-guard) and does
  not want the auto catalog in the system prompt.
- **Fix**: drop the whole `if (skillFileReadTool && skills.length > 0) { … }` block (one call site in
  1.0.1, was two). Skill discovery for `/use-skill` is untouched.
- **Live**: `chunk-5OEJBNHG.js` — the block replaced by `/*P-4*/`. Modular: `dist/core/system-prompt.js`.
- **Verify**: `rg -F "/*P-4*/" dist/bundle/chunks`; `node --check`.

---

## P-5: Fullscreen selection matches WT regular (no copy-on-select, right-click copy, never paste)

**Status: ACTIVE** (re-applied 2026-10-03, pi 1.0.1. Site 1 retired into a setting)

- **Problem**: stock Windows fullscreen still (a) copies on mouse-up, (b) **pastes on right-click**
  (`handleRightClickPaste` is gated on `onRightClickPaste` + `win32` + not-VS Code), (c) keeps a
  reverse-video highlight that looks like soup over styled tokens. Host wants WT-regular behaviour:
  highlight stays until right-click or a key that reaches the editor; right-click copies + clears,
  never pastes; `Shift+Insert` is the paste path; highlight is a flat bar.
- **Fix**:
  1. **Setting, not a patch**: `"fullscreenCopyOnSelect": false` in `~/.pi/agent/settings.json`
     (`interactive-mode` passes `getFullscreenCopyOnSelect()` → alt-screen `copyOnSelect`).
  2. Right-click: `handleRightClickPaste` never calls `onRightClickPaste`; non-empty selection → copy,
     then clear; otherwise consume.
  3. A key that falls through to the editor dismisses the highlight (scroll/search keys keep it).
  4. `applySelectionHighlight` paints theme `selectionBg`/`selectionText` on stripped glyphs.
- **Live**: `dist/bundle/chunks/chunk-6FX7UEPL.js` (3 `/*P-5*/` sites). Mirror:
  `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js` (3 `// P-5:` comments).
  Patched chunk `b85da65167cf04fb0b2adc4e50bfc12ed95ee198d61b62abb020658620abf568`
  (stock = `chunk-6FX7UEPL.js.backup-20261003-183455-hostpatch`).
- **Verify**: `rg -c -F "/*P-5*/" dist/bundle/chunks/chunk-6FX7UEPL.js` → 3; `node --check`; restart Pi:
  select text (no copy, blue bar), right-click copies + clears, right-click with nothing selected does
  nothing, typing clears, `Shift+Insert` pastes.
- **Note**: upstream 1.0.x has a normalized mouse pipeline (`Component.handleMouse`, `TuiMouseEvent`)
  and click-to-caret in the editor — that is why no P-9 exists for mouse caret placement.

---

## P-6: Drop the unused built-in provider catalogs (de-catalog)

**Status: ACTIVE** (re-applied 2026-10-03, pi 1.0.1)

- **Problem**: the live bundle inlines the catalog of all built-in providers as top-level
  `var <provider>_default={…}` data (1.0.1: 42 providers, ~730 KB blanked). Top-level data is parsed
  and evaluated on every start; V8 lazy parsing covers function bodies only.
- **Fix**: `python scripts/pi_runtime_decat.py --apply` (dry run without `--apply`, `--revert` restores
  the newest `*-decat` backup). The script now understands **both** bundle layouts: 0.84
  `flattenModelCatalog("<id>", <var>)` and 0.99+ where one shared groups var feeds
  `flattenChatModelCatalog` / `…Image…` / `…Classifier…` (matches deduped by groups var).
  Keep list is computed from `models.json` / `model-manager.json` plus `STATIC_KEEP` /
  `STATIC_KEEP_EXTRA`, both read from `scripts/pi-runtime-decat.keep.json` (private: it says which
  providers this machine talks to). An id kept by choice rather than by daily use carries a ~234 KB
  eager parse — drop it there if that ever matters.
- **Measured (2026-10-03)**: chunk 3353 → 2623 KB (−730 KB); `node dist/bundle/cli.js --version`
  241 ms warm (compile cache on). 1.0.1 ships more per-provider data than 0.84.4, so the absolute
  saving is larger than the 0.84.4 run (456 → 730 KB).
- **Consequence to remember**: providers that are blanked but still have credentials in `auth.json`
  show no models — after this run that is `openai`, `github-copilot`, `radius`,
  `amazon-bedrock`, `huggingface`, `cloudflare-*`, `baseten`, `fireworks` and the rest outside the keep
  list. `--keep <ids>` only protects against FUTURE blanking — the script skips catalogs already `{}`,
  it does not restore them. Restoring one catalog = splice its object from the newest `*-decat` backup
  into the live chunk (done for one keeps-by-choice catalog 2026-10-21; a blanked catalog also made it invisible in
  /mm — zero registry models — and so unrestorable from the hidden-providers screen, see
  `docs/burned.md` 2026-10-21).
- **Verify**: `node --check <chunk>`; `python scripts/pi_runtime_decat.py` → "already patched";
  `PI_CODING_AGENT_DIR=<throwaway> PI_OFFLINE=1 pi --list-models` lists exactly the host providers with
  no provider-composition error (checked against the host's enabled providers plus `infer`).
- **Upstream**: per-provider dynamic `import()` of catalog data would make this obsolete.

---

## P-7: Terminal title prefix is `pi`, not the π glyph

**Status: ACTIVE** (re-applied 2026-10-03, pi 1.0.1)

- **Problem**: `updateTerminalTitle()` writes OSC 0 as `<APP_TITLE> - <session> - <cwd>`, where
  `APP_TITLE` is the hardcoded glyph `π` unless `package.json` carries `piConfig.name`. No settings
  key, and `ctx.ui.setTitle()` is overwritten by every `updateTerminalTitle()` call.
- **Fix**: `APP_TITLE = piConfigName ? APP_NAME : "pi"`.
- **Live**: `dist/bundle/chunks/chunk-6FX7UEPL.js` — `APP_TITLE=piConfigName?APP_NAME:/*P-7*/"pi"`.
  Modular: `dist/config.js`. Do **not** use `piConfig.name` instead: it renames `APP_NAME`, i.e. the
  `*_CODING_AGENT_DIR` env vars, the debug-log filename, CLI help and the `<name>.cmd` lookup.
- **Verify**: `rg -F '/*P-7*/"pi"' dist/bundle/chunks`; `node -e "import('./dist/config.js').then(m=>console.log(m.APP_TITLE))"` → `pi`.

---

## P-8: No `process.title = APP_NAME` — sub-agent children stop clobbering the window title

**Status: ACTIVE** (re-applied 2026-10-03, pi 1.0.1 — **new file**)

- **Problem**: every `pi` start ran `process.title = APP_NAME`, which on Windows is `SetConsoleTitleW`
  on the shared console. Sub-agent children (`sub-agents/runner.ts` spawns `pi --mode json -p
  --no-session`, same console) therefore rewrote the parent's window title to `pi`.
- **Fix**: delete the assignment in the CLI entry.
- **Live**: `dist/bundle/cli-runtime.js` — 1.0.1 moved the entry out of `cli.js`;
  `function setupCli(){process.title=APP_NAME,` → `function setupCli(){/*P-8*/`.
  Modular: `dist/cli/setup.js` (was `dist/cli.js`). `bundle/rpc-entry.js` stays unpatched (only
  relevant if RPC mode runs inside Pi's console).
- **Verify**: `rg -F "process.title" dist/bundle/cli-runtime.js` → no match; restart Pi, run a
  `spawn_agent` sub-agent, the title stays `pi - <session> - <cwd>`.

---

## P-9: No `/bug`, no `/share` — no report upload, no session gist

**Status: ACTIVE** (added 2026-10-04, pi 1.0.1). 18 anchors: 9 in the core chunk, 9 in the modular
mirror.

- **Problem**: `/bug` (0.86) is only a built-in TUI slash command — a name in `BUILTIN_SLASH_COMMANDS`
  plus a hardcoded `if (text === "/bug")` branch. No setting, no CLI flag, no extension hook: a
  same-named extension command is reported as a conflict, not as an override. So neither the command
  nor its "If this looks like a Pi bug, /bug sends a report" hint (once per session after a
  non-retryable model error) can be switched off by configuration. `/share` is worse than cosmetic: it
  uploads the session through the Radius gateway, falling back to `gh gist create --public=false`.
- **Fix**: delete both command-list entries, delete both dispatch branches, drop the bug-report hint,
  rewrite the two crash messages to name the crash log instead of `/bug`, and return early from
  `shareSession()` so the upload path is unreachable even if something calls it. Only visible strings
  change — the report builder and the gist code stay in the bundle, unreachable.
- **Live**: core chunk `chunk-5OEJBNHG.js` — markers `/*P-9:list-bug*/`, `/*P-9:list-share*/`,
  `/*P-9:dispatch-bug*/`, `/*P-9:dispatch-share*/`, `/*P-9:hint*/`, `/*P-9:share*/`. Modular:
  `dist/core/slash-commands.js`, `dist/modes/interactive/interactive-mode.js`,
  `dist/modes/interactive/session-share.js`, `dist/cli/args.js` (`PI_SHARE_VIEWER_URL` help line).
  Markers are per site on purpose: with a single shared marker a moved anchor would read as
  "already applied".
- **Crash forensics kept**: the crash warning and the resume hint still appear, and now name
  `~/.pi/agent/crashes.json` (`dist/core/crash-log.js`, 5 records / 7 days).
- **Verify**: `py scripts/pi_runtime_patches.py` → 18× P-9 `already`; `rg -c '/share' dist/bundle/chunks`
  → no match; `rg -c '/bug' dist/bundle/chunks` → 1 (the now-unreachable `/v1/bug-reports` endpoint);
  restart Pi and confirm `/` autocomplete lists neither command and no error hint mentions reporting.

---

## P-10: One human duration format for shell timeouts

**Status: ACTIVE** (added 2026-10-05, pi 1.0.1). 5 anchors: 3 in the core chunk, 2 in the modular
renderer mirror.

- **Problem**: Pi's shell tools take `timeout` in **seconds** and render it as such —
  `$ sleep 60 (timeout 300s)` right next to a `1m 30s` ticking timer, and the timeout notice read
  `Command timed out after 300 seconds`. The host's own renderers (`pi-agent-run` pwsh/py,
  `context-guard` bash override) copied that seconds suffix, so every tool header had the same
  unit clash. `bash`'s timeout notice comes from the runtime even under the override (the override
  keeps native `execute`), so the extension side alone cannot fix it.
- **Fix**: install the extension repo's `common/duration.ts` algorithm into Pi's own
  `formatDuration(ms)` and route the three timeout sites through it: the native renderCall suffix
  (`(timeout 300s)` → `(timeout 5m)`) and the timed-out notice (`after 300 seconds` → `after 5m`).
  Replacing the shared `formatDuration` also drops the zero components in the native `Took …` /
  `Elapsed …` lines (`Took 5m 0s` → `Took 5m`). `timeout` stays in seconds in the tool schema and in
  the agent-facing prompt text — only the display changes.
- **Live**: core chunk `chunk-5OEJBNHG.js` — marker `/*P-10*/` on all three sites. Modular:
  `dist/core/tools/renderers/bash.js` (`formatDuration` + the suffix). The modular
  `dist/core/tools/bash.js` timed-out text is **not** patched: `formatDuration` lives in the renderer
  module there, so a modular `node dist/cli.js` run still prints seconds in that one message.
- **Verify**: `py scripts/pi_runtime_patches.py` → 5× P-10 `already`; then, against the live bundle
  (not the mirror): import `dist/bundle/chunks/chunk-5OEJBNHG.js`, call
  `createBashToolDefinition(cwd, { exposeSessionEnvironment: false }).execute(id, { command: "sleep 5",
  timeout: 1 })` → message `Command timed out after 1s`, and `renderCall({ command: "echo hi",
  timeout: 300 }, …)` → `(timeout 5m)`. The repo's own `formatDuration`/`parseDuration` are covered by
  `tests/unit/common-duration.test.ts`.
- **Owned by the repo**: the format is defined in `common/duration.ts` (extension side) — change it
  there first, then mirror it here.

---

## Re-apply checklist after a Pi upgrade

1. Confirm the live bin: `package.json` `"bin": {"pi": "dist/bundle/cli.js"}`, and that `cli.js` is
   still a shim requiring `cli-runtime.js`.
2. Find the chunk holding each patch by content, not by name:
   `rg -l -F "formatSkillsForPrompt" dist/bundle/chunks` (core),
   `rg -l -F "TuiAltScreen=class" dist/bundle/chunks` (TUI),
   `rg -l -F "function setupCli(){" dist/bundle`.
3. `rg -F "/*P-2*/" dist/bundle/chunks` … `/*P-10*/` — whichever marker is missing is wiped; re-apply
   run `python scripts/pi_runtime_patches.py` (check) then `--apply`; if an anchor moved, update it in
   that script first — it asserts each site and refuses to guess.
4. P-1 and P-5 site 1 are settings now: confirm
   `rg -F '"fullscreenWheelScrollLines": 3' ~/.pi/agent/settings.json` and
   `rg -F '"fullscreenCopyOnSelect": false' ~/.pi/agent/settings.json`.
5. P-6: `python scripts/pi_runtime_decat.py` (dry run) → then `--apply`.
6. Update hashes/backup names in this registry after re-applying.
7. Never commit patched dist files to this repo; the runtime is disposable.
8. Never restore a previous-version `*.backup-*` over a newer dist file.
