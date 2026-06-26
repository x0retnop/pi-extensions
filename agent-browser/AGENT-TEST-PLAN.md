# Agent Browser — Universal Stress Test Tasks

Do these tasks in order. The goal is to exercise the browser automation tools across different site types and catch failures, overflows, or agent mistakes.

Use the browser automation skill at `C:\tools\agent-browser\skills\core.md` when you need guidance.

Rules:
- Work only in the user's already-running Chrome.
- Prefer existing tabs. Open a new tab only if the task asks for it.
- Do not close the browser.
- Keep the user's normal browsing session intact.
- If a site does not load or a step fails, note it and move on — do not get stuck retrying.

For each task, report:
- ✅ or ❌
- What you observed
- Any friction, errors, or overflow-sized outputs
- Roughly how many browser interactions it took

---

## Task 1 — Read a simple page

Open `https://example.com`. Tell me the page title and the first heading.

Expected result: a short summary of what the page says.

---

## Task 2 — Fill a basic form

Go to `https://httpbingo.org/forms/post`. Fill in all the fields you see, submit the form, and tell me what the server returned.

Expected result: confirmation that the form submitted and the values echoed back.

---

## Task 3 — Search the web

Go to `https://duckduckgo.com` and search for "agent browser automation". Read the first three result titles and their URLs.

Expected result: three search result titles + URLs.

---

## Task 4 — Navigate a single-page app

Go to `https://github.com/earendil-works`. Switch to the Issues tab (or Pull requests if Issues is empty). Tell me how many open items there are.

Expected result: the number of open issues or pull requests.

---

## Task 5 — Work with tabs

Open `https://news.ycombinator.com` in a new tab. Then switch back to the previous tab and read its title. Finally, switch to the new tab and read the top story title.

Expected result: titles of both tabs + the top HN story.

---

## Task 6 — Follow a link and read the article

On `https://news.ycombinator.com`, click the top story, wait for the article to load, and tell me the article headline.

Expected result: the headline of the article linked from the top HN story.

---

## Task 7 — Block images and verify a specific request

Block all PNG image requests on `https://example.com`, reload the page, and take a screenshot. Then list only the blocked PNG requests using a pattern filter.

Expected result: screenshot shows the page without images, and you can list the blocked PNG requests without returning a huge unfiltered log.

---

## Task 8 — Save and restore session state

Go to `https://httpbingo.org/cookies/set?test=value123`. Confirm the cookie is set. Save the browser state to a file. Then open a fresh isolated browser session, load the saved state, and visit `https://httpbingo.org/cookies`. Confirm the cookie is still there.

Expected result: the `test=value123` cookie persists across sessions.

---

## Task 9 — Scroll a feed

Go to `https://infinitescroll-six.vercel.app/` and scroll down once. Confirm that new content loaded.

Expected result: new items appear after scrolling.

---

## Task 10 — Check the weather

Go to `https://www.bbc.com/weather/2643743` and read the current temperature and condition for London.

Expected result: current temperature + condition for London.

---

## Task 11 — Use web search to pick a current article

Use the web search tool to find a recent news article about "AI browser automation" from 2025 or 2026. Open the article in a new tab and summarize the first three paragraphs.

Expected result: article title, source, and a short summary.

---

## Final report

For each task, include:
- ✅ or ❌
- What you observed
- Any friction or unexpected behavior
- Whether any tool returned an unexpectedly large output

Be honest about failures — they tell us what to improve.
