# Handoff — Pi Extensions Collection Cleanup

## What was done in the previous session

### READMEs rewritten (new, clean, English only)
- `pi-multi-edit/README.md` — batch/multi/patch edit tool, tradeoff noted.
- `read-mode/README.md` — mode-based read tool (overview/section/grep/headtail/raw).
- `grep-tool/README.md` — ripgrep-based project search.
- `pi-web-access/README.md` — fully rewritten after major refactor.

### pi-web-access refactor
- **Removed:** Gemini Web stack (`gemini-web.ts`, `gemini-search.ts`, `gemini-web-config.ts`, `chrome-cookies.ts`, `AGENTS.md`).
- **Merged in:** Ollama Cloud `web_search` + `web_fetch` from `ollama-cloud-web/`.
- **New files:** `config.ts` (settings.json/auth.json), `ollama.ts`, `search-orchestrator.ts`.
- **Simplified tools:** removed `get_search_content` and background-fetch complexity. Now 3 tools only: `web_search`, `fetch_content`, `code_search`.
- **Agent guidelines** rewritten to describe actual workflow (when to use which tool, single vs multi URL, includeContent flag, code_search vs web_search boundary).
- Version bumped to `0.11.0`.

## What remains

Review and clean the remaining extensions in this collection. Follow the same pattern:

1. **Check agent-facing surface** — tool descriptions, promptGuidelines, parameter descriptions. Are they clear to an agent? Do they explain when/how to use the tool?
2. **Check dead code / obsolete features** — remove or comment out things that don't work or are abandoned.
3. **README** — create new clean `README.md` (English only) if the old one is messy, outdated, or mixes languages. If an extension is abandoned or "just in case", either remove the README or mark it clearly.
4. **Authorship / attribution** — if an extension is a fork/modification, state the original author and what was changed.

## Suggested priority order

High impact / frequently used first:

1. **`simple-gate`** — permission gate, likely used heavily. Check if guidelines and behavior are clear.
2. **`role-sw`** — role switcher. Simple but needs clean README.
3. **`context`** — context overview tool. Check agent-facing descriptions.
4. **`handoff`** — handoff command. Check reliability and clarity.
5. **`a-rewind`** — rewind/guard. Check if still needed after Pi updates.
6. **`asku`** — ask-user tool. Compact but verify README.
7. **`btw`** — side questions. Verify it still works and README is clean.
8. **`pi-docs-toggle`** — docs stripper. Verify compatibility with current Pi version.
9. **`pi-session-memory`** — semantic session search. Check if dependencies (0x010 server) are still relevant.
10. **`pi-skill-guard`** — skill injection control. Check agent guidelines.
11. **`pi-request-inspector`** — request dump. Check README.
12. **`auto-trust`** — tiny extension, might be obsolete.
13. **`sessions`** — session picker. Check if still useful.
14. **`pi-tool-codex`** — this is a large fork of `@vinyroli/pi-tool-codex`. Decide if it stays or gets stripped.
15. **`pi-xai-oauth`** — xAI OAuth fork with toggle. Check if still works.
16. **`ollama-cloud-web`** — **can be removed** since its functionality was merged into `pi-web-access`.

## Notes

- Keep all text English only.
- Do not over-explain in READMEs. State what it does, key features, install line, parameters table or examples. No marketing language.
- If an extension is clearly abandoned or only kept "just in case", consider deleting its README or moving it to a `deprecated/` note so it doesn't clutter the public view.
- The collection's top-level `README.md` still needs to be rewritten as a clean index. Do that after individual extensions are settled.
- `pi-web-access` still has some TS warnings from missing npm types (`@mozilla/readability`, `linkedom`, etc.) — these are expected in the dev environment without `node_modules`; do not try to fix them by adding dependencies.
