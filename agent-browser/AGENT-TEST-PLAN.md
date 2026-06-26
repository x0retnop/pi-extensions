# Agent Browser — Universal Agent Test Plan

Use this plan to exercise `agent-browser` tools across a variety of real sites and interaction patterns. The goal is to verify that the tools are **agent-friendly and generic**, not tuned for one site.

## Preparation

1. Read `agent-browser/skills/core.md`.
2. Start with `cdp_url:"http://127.0.0.1:9222/"` on the first browser call.
3. Use a fresh `session:<name>` for each independent scenario so failures do not leak.
4. After every navigation/click/submit, re-snapshot before using `@eN` refs again.
5. Prefer `@eN` refs, fall back to CSS selectors or aria-labels if refs go stale.

## Report format

For each task report:
- ✅/❌ success
- Number of tool calls used
- Any manual workarounds needed
- Concrete UX friction

---

## Level 1 — Static page basics

**Site:** `https://example.com` or `https://httpbin.org/html`

**Tasks:**
1. `browser action:open url:...`
2. `browser action:snapshot`
3. `browser action:text`
4. `browser action:screenshot screenshot_path:./example.png`
5. `browser action:close`

**Success criteria:**
- Snapshot shows the page structure.
- `text` returns readable page content.
- Screenshot file is created.

---

## Level 2 — Simple HTML form

**Site:** `https://httpbin.org/forms/post`

**Tasks:**
1. Open the form.
2. Snapshot it.
3. Fill all visible fields using refs or labels.
4. Submit the form (`action:submit` or manual fill → click).
5. Read the submitted data from the result page.

**Success criteria:**
- All fields filled without hard-coded selectors.
- Submit succeeds.
- Result page contains the submitted values.

---

## Level 3 — Search engine

**Site:** `https://duckduckgo.com` or `https://www.google.com`

**Tasks:**
1. Open the search engine.
2. Find the search input using only the snapshot.
3. Type a query and submit.
4. Wait for results (use `wait_after:"results"` or poll `text`).
5. Extract the titles + URLs of the first 3 results.

**Success criteria:**
- Query submitted without knowing the input selector in advance.
- Results page loaded.
- At least 3 result titles extracted.

---

## Level 4 — SPA navigation

**Site:** `https://github.com/earendil-works` (or any SPA with tabs)

**Tasks:**
1. Open a repository page.
2. Click a tab (Issues, Pull requests, Actions).
3. Wait for the SPA route to load.
4. Snapshot the new content.
5. Read the count of open items from the tab label or page text.

**Success criteria:**
- Tab switch works.
- New content appears without a full page reload.
- Numeric count extracted correctly.

---

## Level 5 — Tab management

**Sites:** any two from above

**Tasks:**
1. Open site A in the default tab.
2. Open site B in a new tab (`action:open url:...` with `--new-tab` via `extra_args` if supported, or open in current then use `action:tabs`).
3. List tabs.
4. Switch back to site A.
5. Read its title.
6. Close the session.

**Success criteria:**
- Multiple tabs coexist.
- Switching returns to the correct page.
- Title matches.

---

## Level 6 — Dynamic content / polling

**Site:** `https://news.ycombinator.com` or any news site

**Tasks:**
1. Open the front page.
2. Read the top story title and URL.
3. Click the top story.
4. Wait for the article to load.
5. Extract the article headline.

**Success criteria:**
- Top story identified from the list.
- Click navigates to the article.
- Headline readable after the page settles.

---

## Level 7 — Network interception

**Site:** `https://example.com`

**Tasks:**
1. `browser_network action:route pattern:"**/*.png" abort:true`
2. Open `https://example.com`.
3. Take a screenshot.
4. `browser_network action:requests`
5. Verify that image requests were blocked.
6. `browser_network action:unroute pattern:"**/*.png"`

**Success criteria:**
- Route set before navigation.
- Image requests appear as blocked/cancelled.
- Screenshot renders without images (or with broken image placeholders).

---

## Level 8 — Cookies / state

**Site:** `https://httpbin.org/cookies/set?test=value123`

**Tasks:**
1. Open the cookie-setting URL.
2. `browser_state action:cookies`
3. Verify `test=value123` is present.
4. `browser_state action:state_save path:./httpbin-state.json`
5. Open a new session.
6. `browser_state action:state_load path:./httpbin-state.json`
7. Open `https://httpbin.org/cookies` and confirm the cookie persists.

**Success criteria:**
- Cookie saved and loaded across sessions.

---

## Level 9 — Complex interaction (choose one)

**Option A — Hover menu:**
- Site with a hover dropdown (e.g. a documentation navbar).
- Hover over the menu item via `eval` or `extra_args`.
- Click a link from the dropdown.

**Option B — Infinite scroll:**
- A site with infinite scroll (e.g. a social feed).
- Scroll down via `eval` (`window.scrollBy(0, 1000)`).
- Verify new items loaded.

**Option C — File download:**
- A site with a direct download link.
- Click the link.
- Verify the file appears in the downloads directory (via `bash ls`).

**Success criteria:**
- Interaction completed without site-specific hard-coding.
- Result observable either in the browser or on disk.

---

## Level 10 — Multi-step real-world flow

**Scenario:** Check the weather for a city.

**Site:** any weather site (e.g. `https://openweathermap.org` or `https://weather.com`)

**Tasks:**
1. Open the weather site.
2. Find the city search input from the snapshot.
3. Type a city name and submit.
4. Wait for the forecast page.
5. Extract current temperature and condition (e.g. "Sunny", "Rain").

**Success criteria:**
- City found.
- Forecast data extracted.
- No hard-coded selectors used.

---

## Expected global outcomes

After running the plan, the agent should be able to say:
- Which actions worked out of the box.
- Where refs were reliable vs. where CSS/aria-label fallback was needed.
- Whether auto-waits were sufficient or manual waits/polling were required.
- Which sites needed `extra_args` or `eval` workarounds.
- Any missing actions (scroll, hover, file upload, etc.).

---

## Notes for the maintainer

This plan is intentionally site-agnostic. Do not hard-code selectors here. If an agent repeatedly fails a task because of a missing tool feature, that feature should be added to `browser.ts` or documented as a known limitation.
