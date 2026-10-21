import assert from "node:assert";
import { describe, it } from "node:test";

import {
  canonicalUrl,
  dedupResults,
  interleaveResults,
  splitExaFetchBlocks,
  parseExaSearchText,
  decodeBingUrl,
  searchWithChain,
  defaultProviderChain,
  cleanPublishedDate,
  classifySearchError,
  fallbackReason,
  formatSearchFooter,
  formatSearchMarkdown,
  reorderProvidersForFilters,
  domainFilterToQuerySuffix,
  isExaFetchError,
  sanitizeSnippet,
  decodeHtml,
  type SearchProvider,
  type SearchOptions,
  type SearchResult,
} from "../../web-search-st/providers.js";
import { parseCurlHttpCode, lastContentType, headerValue } from "../../web-search-st/curl.js";
import webSearchFactory from "../../web-search-st/index.js";
import {
  normalizeText, extractFromHtml, parseJinaText, applyOverflow, classifyFetchError,
  isCloudflareChallenge, jinaTargetError, preservePlainText,
} from "../../web-search-st/fetcher.js";
import { unlinkSync, readFileSync } from "node:fs";
import {
  normalizeChain,
  normalizeDisabled,
  moveProvider,
  resolveKey,
  keySource,
  maskKey,
  loadWebSearchSettings,
  providerEnabled,
} from "../../web-search-st/settings.js";

// ---------------------------------------------------------------------------
// canonicalUrl
// ---------------------------------------------------------------------------

describe("web-search-st canonicalUrl", () => {
  it("lowercases scheme and host", () => {
    assert.strictEqual(
      canonicalUrl("HTTPS://NodeJS.ORG/en/about"),
      "https://nodejs.org/en/about",
    );
  });

  it("drops www. prefix", () => {
    assert.strictEqual(
      canonicalUrl("https://www.example.com/path"),
      "https://example.com/path",
    );
  });

  it("drops fragments", () => {
    assert.strictEqual(
      canonicalUrl("https://example.com/page#section-2"),
      "https://example.com/page",
    );
  });

  it("strips tracking query params", () => {
    assert.strictEqual(
      canonicalUrl("https://example.com/page?utm_source=x&id=1&utm_medium=y"),
      "https://example.com/page?id=1",
    );
  });

  it("sorts remaining query params", () => {
    assert.strictEqual(
      canonicalUrl("https://example.com/p?b=2&a=1"),
      "https://example.com/p?a=1&b=2",
    );
  });

  it("normalizes trailing slash on path", () => {
    assert.strictEqual(
      canonicalUrl("https://example.com/path/"),
      "https://example.com/path",
    );
    // root path stays "/"
    assert.strictEqual(canonicalUrl("https://example.com"), "https://example.com/");
  });

  it("returns raw string for unparseable input", () => {
    assert.strictEqual(canonicalUrl("not a url"), "not a url");
    assert.strictEqual(canonicalUrl(""), "");
  });

  it("collapses near-identical links", () => {
    assert.strictEqual(
      canonicalUrl("https://www.example.com/page?utm_source=news"),
      canonicalUrl("https://example.com/page"),
    );
  });
});

// ---------------------------------------------------------------------------
// dedupResults
// ---------------------------------------------------------------------------

describe("web-search-st dedupResults", () => {
  const base = (url: string, title = "t"): SearchResult => ({
    title, url, snippet: "", sourceProvider: "test",
  });

  it("drops duplicates by canonical URL preserving first-seen order", () => {
    const out = dedupResults([
      base("https://example.com/a"),
      base("https://example.com/b"),
      base("https://www.example.com/a?utm_source=x"),
      base("https://example.com/b#frag"),
    ]);
    assert.deepStrictEqual(out.map((r) => r.url), [
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("keeps distinct URLs", () => {
    const out = dedupResults([
      base("https://example.com/a"),
      base("https://other.org/b"),
    ]);
    assert.strictEqual(out.length, 2);
  });

  it("handles empty input", () => {
    assert.deepStrictEqual(dedupResults([]), []);
  });
});

describe("web-search-st interleaveResults", () => {
  const base = (url: string): SearchResult => ({
    title: url, url, snippet: "", sourceProvider: "test",
  });

  it("round-robins groups so later queries stay visible", () => {
    const out = interleaveResults([
      [base("https://a.com/1"), base("https://a.com/2"), base("https://a.com/3")],
      [base("https://b.com/1"), base("https://b.com/2")],
    ]);
    assert.deepStrictEqual(out.map((r) => r.url), [
      "https://a.com/1", "https://b.com/1",
      "https://a.com/2", "https://b.com/2",
      "https://a.com/3",
    ]);
  });

  it("handles empty groups", () => {
    assert.deepStrictEqual(interleaveResults([]), []);
    assert.deepStrictEqual(interleaveResults([[], [base("https://a.com")]]).map((r) => r.url), ["https://a.com"]);
  });
});

// ---------------------------------------------------------------------------
// splitExaFetchBlocks
// ---------------------------------------------------------------------------

describe("web-search-st splitExaFetchBlocks", () => {
  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(splitExaFetchBlocks(""), []);
    assert.deepStrictEqual(splitExaFetchBlocks("   \n  "), []);
  });

  it("returns one block for a single URL result", () => {
    const text = "# Title One\nURL: https://a.com/x\n\ncontent here";
    const blocks = splitExaFetchBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.match(blocks[0], /# Title One/);
    assert.match(blocks[0], /content here/);
  });

  it("splits multiple URL results on URL: boundaries", () => {
    const text = [
      "# First Page\nURL: https://a.com/one\n\nbody of first",
      "# Second Page\nURL: https://b.com/two\n\nbody of second",
    ].join("\n");
    const blocks = splitExaFetchBlocks(text);
    assert.strictEqual(blocks.length, 2);
    assert.match(blocks[0], /First Page/);
    assert.match(blocks[1], /Second Page/);
    assert.match(blocks[0], /body of first/);
    assert.match(blocks[1], /body of second/);
  });

  it("does not split on # headers inside page content", () => {
    const text = [
      "# Page\nURL: https://a.com/x\n\nintro",
      "## Section Inside\nmore text",
      "# Second URL Block\nURL: https://b.com/y\n\nother page",
    ].join("\n");
    const blocks = splitExaFetchBlocks(text);
    assert.strictEqual(blocks.length, 2);
    assert.match(blocks[0], /Section Inside/);
    assert.match(blocks[1], /Second URL Block/);
  });

  it("does not split when URL: appears mid-content without a header", () => {
    const text = "# Page\nURL: https://a.com/x\n\nsee https://a.com/other for more";
    const blocks = splitExaFetchBlocks(text);
    assert.strictEqual(blocks.length, 1);
  });
});

// ---------------------------------------------------------------------------
// parseExaSearchText
// ---------------------------------------------------------------------------

describe("web-search-st parseExaSearchText", () => {
  it("parses Title/URL/Published/Highlights", () => {
    const text = [
      "Title: Running TypeScript Natively | Node.js Learn",
      "URL: https://nodejs.org/learn/typescript/run-natively",
      "Published: 2026-01-15",
      "Author: Jane Doe",
      "Highlights:",
      "- You can run TypeScript directly in Node.js.",
      "- Type stripping removes erasable syntax.",
    ].join("\n");
    const results = parseExaSearchText(text);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].title, "Running TypeScript Natively | Node.js Learn");
    assert.strictEqual(results[0].url, "https://nodejs.org/learn/typescript/run-natively");
    assert.strictEqual(results[0].publishedDate, "2026-01-15");
    assert.match(results[0].snippet, /TypeScript directly/);
    assert.strictEqual(results[0].sourceProvider, "exa");
  });

  it("parses multiple result entries separated by blank lines", () => {
    const text = [
      "Title: One\nURL: https://a.com/1\nHighlights:\n- snippet a",
      "Title: Two\nURL: https://b.com/2\nHighlights:\n- snippet b",
    ].join("\n\n");
    const results = parseExaSearchText(text);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].url, "https://a.com/1");
    assert.strictEqual(results[1].url, "https://b.com/2");
  });

  it("skips entries without a URL", () => {
    const text = "Title: No URL here\nHighlights:\n- something";
    assert.deepStrictEqual(parseExaSearchText(text), []);
  });

  it("falls back to URL as title when Title missing", () => {
    const text = "URL: https://a.com/x\nHighlights:\n- h";
    const results = parseExaSearchText(text);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].title, "https://a.com/x");
  });

  it("drops Published: N/A placeholders", () => {
    const text = "Title: One\nURL: https://a.com/1\nPublished: N/A\nHighlights:\n- s";
    const results = parseExaSearchText(text);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].publishedDate, undefined);
  });
});

describe("web-search-st cleanPublishedDate", () => {
  it("keeps real dates and drops placeholders", () => {
    assert.strictEqual(cleanPublishedDate("2026-01-15"), "2026-01-15");
    assert.strictEqual(cleanPublishedDate("N/A"), undefined);
    assert.strictEqual(cleanPublishedDate("n/a"), undefined);
    assert.strictEqual(cleanPublishedDate("-"), undefined);
    assert.strictEqual(cleanPublishedDate(""), undefined);
    assert.strictEqual(cleanPublishedDate(undefined), undefined);
  });
});

describe("web-search-st curl helpers", () => {
  it("parses -w http_code and rejects header-file text", () => {
    assert.strictEqual(parseCurlHttpCode("200"), 200);
    assert.strictEqual(parseCurlHttpCode("404\n"), 404);
    assert.strictEqual(parseCurlHttpCode("HTTP/1.1 200 OK"), 0);
    assert.strictEqual(parseCurlHttpCode(""), 0);
  });

  it("reads session id and last content-type from header dumps", () => {
    const hdr = [
      "HTTP/1.1 302 Found",
      "content-type: text/html",
      "",
      "HTTP/1.1 200 OK",
      "mcp-session-id: abc-123",
      "Content-Type: text/markdown; charset=utf-8",
      "",
    ].join("\r\n");
    assert.strictEqual(headerValue(hdr, "mcp-session-id"), "abc-123");
    assert.strictEqual(lastContentType(hdr), "text/markdown; charset=utf-8");
  });
});

describe("web-search-st defaultProviderChain", () => {
  it("includes keyed providers even without keys", () => {
    const chain = defaultProviderChain({});
    assert.deepStrictEqual(chain.map((p) => p.name), ["exa", "brave", "tavily", "bing"]);
    assert.strictEqual(chain.find((p) => p.name === "exa")!.isAvailable(), true);
    assert.strictEqual(chain.find((p) => p.name === "brave")!.isAvailable(), false);
    assert.strictEqual(chain.find((p) => p.name === "tavily")!.isAvailable(), false);
    assert.strictEqual(chain.find((p) => p.name === "bing")!.isAvailable(), true);
  });

  it("marks keyed providers available when env is set", () => {
    const chain = defaultProviderChain({ BRAVE_API_KEY: "b", TAVILY_API_KEY: "t" });
    assert.strictEqual(chain.find((p) => p.name === "brave")!.isAvailable(), true);
    assert.strictEqual(chain.find((p) => p.name === "tavily")!.isAvailable(), true);
  });

  it("omits disabled providers and honors custom order", () => {
    const chain = defaultProviderChain({
      chain: ["bing", "exa", "brave"],
      disabled: ["exa"],
    });
    // Missing names are appended (tavily), disabled names are dropped (exa).
    assert.deepStrictEqual(chain.map((p) => p.name), ["bing", "brave", "tavily"]);
  });
});

describe("web-search-st settings helpers", () => {
  it("normalizes chain order and drops junk", () => {
    assert.deepStrictEqual(normalizeChain(["bing", "exa", "exa", "nope"]), ["bing", "exa", "brave", "tavily"]);
    assert.deepStrictEqual(normalizeChain(undefined), ["exa", "brave", "tavily", "bing"]);
  });

  it("normalizes disabled list", () => {
    assert.deepStrictEqual(normalizeDisabled(["exa", "exa", "nope", "bing"]), ["exa", "bing"]);
  });

  it("moves providers within the chain", () => {
    assert.deepStrictEqual(moveProvider(["exa", "brave", "tavily", "bing"], "brave", -1), ["brave", "exa", "tavily", "bing"]);
    assert.deepStrictEqual(moveProvider(["exa", "brave", "tavily", "bing"], "exa", -1), ["exa", "brave", "tavily", "bing"]);
    assert.deepStrictEqual(moveProvider(["exa", "brave", "tavily", "bing"], "bing", 1), ["exa", "brave", "tavily", "bing"]);
  });

  it("resolves keys with env winning over saved", () => {
    assert.strictEqual(resolveKey("env-key", "saved"), "env-key");
    assert.strictEqual(resolveKey("  ", "saved"), "saved");
    assert.strictEqual(resolveKey(undefined, "saved"), "saved");
    assert.strictEqual(resolveKey(undefined, ""), "");
  });

  it("reports key source and masks secrets", () => {
    assert.strictEqual(keySource("env", "saved"), "env");
    assert.strictEqual(keySource("", "saved"), "saved");
    assert.strictEqual(keySource(undefined, ""), "none");
    assert.strictEqual(maskKey(""), "(empty)");
    assert.strictEqual(maskKey("abcdefghij"), "****ghij");
  });

  it("loads defaults from an empty settings object", () => {
    const s = loadWebSearchSettings({});
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.fallback, true);
    assert.deepStrictEqual(s.chain, ["exa", "brave", "tavily", "bing"]);
    assert.deepStrictEqual(s.disabled, []);
    assert.strictEqual(s.braveKey, "");
  });
});

// ---------------------------------------------------------------------------
// decodeBingUrl
// ---------------------------------------------------------------------------

describe("web-search-st decodeBingUrl", () => {
  it("decodes ck/a base64url u-param", () => {
    // base64url("https://nodejs.org/") = aHR0cHM6Ly9ub2RlanMub3JnLw
    const href = `https://www.bing.com/ck/a?!&p=abc&u=a1${"aHR0cHM6Ly9ub2RlanMub3JnLw"}`;
    assert.strictEqual(decodeBingUrl(href), "https://nodejs.org/");
  });

  it("returns href unchanged when no u-param", () => {
    const href = "https://www.bing.com/ck/a?!&p=abc";
    assert.strictEqual(decodeBingUrl(href), href);
  });

  it("handles &amp; escaped separators", () => {
    const href = `https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${"aHR0cHM6Ly9ub2RlanMub3JnLw"}`;
    assert.strictEqual(decodeBingUrl(href), "https://nodejs.org/");
  });

  it("returns href when u-param is not a1-prefixed", () => {
    const href = "https://www.bing.com/ck/a?u=zzz";
    assert.strictEqual(decodeBingUrl(href), href);
  });

  it("tolerates invalid base64", () => {
    const href = `https://www.bing.com/ck/a?u=a1${"!!!"}`;
    assert.strictEqual(typeof decodeBingUrl(href), "string");
  });
});

// ---------------------------------------------------------------------------
// normalizeText
// ---------------------------------------------------------------------------

describe("web-search-st normalizeText", () => {
  it("collapses runs of blank lines", () => {
    const out = normalizeText("a\n\n\n\nb");
    assert.strictEqual(out, "a\n\nb");
  });

  it("joins ragged one-word lines into paragraphs", () => {
    const out = normalizeText("This is a\nlong paragraph\nsplit over lines");
    assert.strictEqual(out, "This is a long paragraph split over lines");
  });

  it("keeps structural blocks separate (headings)", () => {
    const out = normalizeText("intro line\n# Heading\nbody line");
    assert.strictEqual(out, "intro line\n\n# Heading\n\nbody line");
  });

  it("keeps list items separate", () => {
    const out = normalizeText("intro\n- item one\n- item two");
    // Each list item is its own structural block (matches backend behavior).
    assert.strictEqual(out, "intro\n\n- item one\n\n- item two");
  });

  it("keeps code blocks separate", () => {
    const out = normalizeText("before\n```js\nconst a = 1;\n```\nafter");
    assert.match(out, /```js/);
    assert.match(out, /\n\n```js\n\n/);
  });

  it("keeps lines ending with colon separate (block intro)", () => {
    const out = normalizeText("Usage:\nrun it now");
    assert.strictEqual(out, "Usage:\n\nrun it now");
  });

  it("normalizes CRLF and trims", () => {
    const out = normalizeText("  a\r\n\r\nb  \r\n");
    assert.strictEqual(out, "a\n\nb");
  });
});

// ---------------------------------------------------------------------------
// extractFromHtml
// ---------------------------------------------------------------------------

describe("web-search-st extractFromHtml", () => {
  it("extracts title and strips scripts/styles", () => {
    const html = "<html><head><title>My Page</title></head><body>"
      + "<script>bad()</script><style>.x{}</style>"
      + "<main><p>Hello world</p></main></body></html>";
    const { title, text } = extractFromHtml(html);
    assert.strictEqual(title, "My Page");
    assert.match(text, /Hello world/);
    assert.doesNotMatch(text, /bad\(\)/);
  });

  it("removes nav/footer/aside", () => {
    const html = "<body><nav>menu</nav><footer>foot</footer>"
      + "<main><p>content</p></main></body>";
    const { text } = extractFromHtml(html);
    assert.match(text, /content/);
    assert.doesNotMatch(text, /menu/);
    assert.doesNotMatch(text, /foot/);
  });

  it("prefers main over body", () => {
    const html = "<body><p>body text</p><main><p>main text</p></main></body>";
    const { text } = extractFromHtml(html);
    assert.match(text, /main text/);
    assert.doesNotMatch(text, /body text/);
  });

  it("decodes HTML entities", () => {
    const html = "<body><main><p>a &amp; b &lt; c</p></main></body>";
    const { text } = extractFromHtml(html);
    assert.match(text, /a & b < c/);
  });
});

// ---------------------------------------------------------------------------
// searchWithChain — provider chain behavior with fake providers (no network)
// ---------------------------------------------------------------------------

class FakeProvider implements SearchProvider {
  constructor(
    public name: string,
    private behavior: "ok" | "empty" | "throw",
    private results: SearchResult[] = [],
  ) {}
  isAvailable(): boolean { return true; }
  async search(_query: string, _options: SearchOptions): Promise<SearchResult[]> {
    if (this.behavior === "throw") throw new Error("exploded");
    if (this.behavior === "empty") return [];
    return this.results;
  }
}

const mk = (url: string, title: string): SearchResult => ({ title, url, snippet: "", sourceProvider: "fake" });

describe("web-search-st searchWithChain", () => {
  it("uses first provider that returns results", async () => {
    const providers = [
      new FakeProvider("p1", "empty"),
      new FakeProvider("p2", "ok", [mk("https://a.com", "A")]),
      new FakeProvider("p3", "ok", [mk("https://b.com", "B")]),
    ];
    const out = await searchWithChain(["q"], { numResults: 5 }, providers);
    assert.strictEqual(out.providerUsed, "p2");
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.fallbackUsed, true); // p1 was empty
  });

  it("falls through on provider error", async () => {
    const providers = [
      new FakeProvider("p1", "throw"),
      new FakeProvider("p2", "ok", [mk("https://a.com", "A")]),
    ];
    const out = await searchWithChain(["q"], { numResults: 5 }, providers);
    assert.strictEqual(out.providerUsed, "p2");
    assert.match(out.errors.join(";"), /p1: exploded/);
    assert.strictEqual(out.fallbackUsed, true);
  });

  it("respects preferredProvider and moves it first", async () => {
    const providers = [
      new FakeProvider("p1", "ok", [mk("https://a.com", "A")]),
      new FakeProvider("p2", "ok", [mk("https://b.com", "B")]),
    ];
    const out = await searchWithChain(["q"], { numResults: 5, preferredProvider: "p2" }, providers);
    assert.strictEqual(out.providerUsed, "p2");
  });

  it("stops after preferredProvider error when allowFallback=false", async () => {
    const providers = [
      new FakeProvider("p1", "throw"),
      new FakeProvider("p2", "ok", [mk("https://b.com", "B")]),
    ];
    const out = await searchWithChain(["q"], { numResults: 5, preferredProvider: "p1", allowFallback: false }, providers);
    assert.strictEqual(out.results.length, 0);
    assert.match(out.errors.join(";"), /p1: exploded/);
  });

  it("stops after empty preferred provider when allowFallback=false", async () => {
    const providers = [
      new FakeProvider("p1", "empty"),
      new FakeProvider("p2", "ok", [mk("https://b.com", "B")]),
    ];
    const out = await searchWithChain(["q"], { numResults: 5, preferredProvider: "p1", allowFallback: false }, providers);
    assert.strictEqual(out.results.length, 0);
    assert.strictEqual(out.providerUsed, null);
    assert.strictEqual(out.fallbackUsed, true);
  });

  it("runs queries in parallel", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const provider: SearchProvider = {
      name: "p",
      isAvailable: () => true,
      async search(query: string) {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight--;
        return [mk(`https://x.com/${query}`, query)];
      },
    };
    const out = await searchWithChain(["a", "b", "c"], { numResults: 3 }, [provider]);
    assert.strictEqual(out.results.length, 3);
    assert.ok(maxInflight >= 2, `expected parallel inflight>=2, got ${maxInflight}`);
  });

  it("interleaves queries then caps at numResults", async () => {
    const provider: SearchProvider = {
      name: "p",
      isAvailable: () => true,
      async search(query: string) {
        const host = query === "q1" ? "a.com" : "b.com";
        return [1, 2, 3].map((n) => mk(`https://${host}/${n}`, `${query}-${n}`));
      },
    };
    const out = await searchWithChain(["q1", "q2"], { numResults: 4 }, [provider]);
    assert.deepStrictEqual(out.results.map((r) => r.url), [
      "https://a.com/1", "https://b.com/1", "https://a.com/2", "https://b.com/2",
    ]);
  });

  it("merges and dedups multi-query results", async () => {
    const providers = [
      new FakeProvider("p1", "ok", [
        mk("https://a.com/x", "X1"),
        mk("https://b.com/y", "Y1"),
      ]),
    ];
    const out = await searchWithChain(["q1", "q2"], { numResults: 5 }, providers);
    assert.strictEqual(out.results.length, 2);
    assert.strictEqual(out.providerUsed, "p1");
  });

  it("dedups results with tracking params across queries", async () => {
    const providers = [
      new FakeProvider("p1", "ok", [
        mk("https://a.com/x", "X1"),
        mk("https://www.a.com/x?utm_source=nl", "X2"),
      ]),
    ];
    const out = await searchWithChain(["q1"], { numResults: 5 }, providers);
    assert.strictEqual(out.results.length, 1);
  });

  it("reports empty result when every provider returns nothing", async () => {
    const providers = [new FakeProvider("p1", "empty"), new FakeProvider("p2", "empty")];
    const out = await searchWithChain(["q"], { numResults: 5 }, providers);
    assert.strictEqual(out.results.length, 0);
    assert.strictEqual(out.providerUsed, null);
    assert.strictEqual(out.fallbackUsed, true);
  });

  it("skips unavailable providers", async () => {
    const p1 = new FakeProvider("p1", "throw");
    p1.isAvailable = () => false;
    const providers = [p1, new FakeProvider("p2", "ok", [mk("https://a.com", "A")])];
    const out = await searchWithChain(["q"], { numResults: 5 }, providers);
    assert.strictEqual(out.providerUsed, "p2");
    assert.strictEqual(out.errors.length, 0);
    assert.strictEqual(out.fallbackUsed, false);
    assert.strictEqual(out.attempts[0].status, "skipped");
  });

  it("records attempts and a short fallback reason", async () => {
    const providers = [
      new FakeProvider("p1", "throw"),
      new FakeProvider("p2", "ok", [mk("https://a.com", "A")]),
    ];
    const out = await searchWithChain(["q"], { numResults: 5 }, providers);
    assert.deepStrictEqual(out.attempts.map((a) => a.status), ["error", "ok"]);
    assert.deepStrictEqual(out.providersUsed, ["p2"]);
    assert.strictEqual(fallbackReason(out.attempts), "p1 exploded");
    assert.match(formatSearchFooter(out), /via p2/);
    assert.match(formatSearchFooter(out), /fallback: p1 exploded/);
  });
});

describe("web-search-st sanitizeSnippet", () => {
  it("strips tags and decodes Brave-style entities", () => {
    const out = sanitizeSnippet("Grok 4.6 <strong>builds on</strong> Grok 4.5&#x27;s work &amp; more");
    assert.strictEqual(out, "Grok 4.6 builds on Grok 4.5's work & more");
  });

  it("collapses whitespace and caps length", () => {
    assert.strictEqual(decodeHtml("  a   <b>b</b>\n\nc  "), "a b c");
    assert.strictEqual(sanitizeSnippet("x".repeat(50), 10), "x".repeat(10));
  });
});

describe("web-search-st providerEnabled", () => {
  it("treats missing/empty disabled as enabled", () => {
    assert.strictEqual(providerEnabled(undefined, "exa"), true);
    assert.strictEqual(providerEnabled([], "exa"), true);
  });

  it("honors disabled list", () => {
    assert.strictEqual(providerEnabled(["exa"], "exa"), false);
    assert.strictEqual(providerEnabled(["exa"], "brave"), true);
  });
});

describe("web-search-st classifySearchError", () => {
  it("collapses 429 / HTTP / timeout", () => {
    assert.strictEqual(classifySearchError(new Error("Brave rate limited (429)")), "429");
    assert.strictEqual(classifySearchError(new Error("Exa MCP call HTTP 403")), "HTTP 403");
    assert.strictEqual(classifySearchError(new Error("aborted")), "timeout");
  });
});

describe("web-search-st classifyFetchError", () => {
  it("collapses 429 / HTTP / timeout", () => {
    assert.strictEqual(classifyFetchError(new Error("Jina HTTP 403")), "HTTP 403");
    assert.strictEqual(classifyFetchError(new Error("rate limited")), "429");
    assert.strictEqual(classifyFetchError(new Error("aborted")), "timeout");
  });
});

describe("web-search-st formatSearchMarkdown", () => {
  it("numbers results and keeps the footer", () => {
    const md = formatSearchMarkdown([
      { title: "One", url: "https://a.com", snippet: "aaa", sourceProvider: "exa" },
      { title: "Two", url: "https://b.com", snippet: "", sourceProvider: "brave", publishedDate: "1d" },
    ], "via exa · 2 results");
    assert.match(md, /^1\. \*\*One\*\*/m);
    assert.match(md, /URL: https:\/\/a\.com/);
    assert.match(md, /aaa/);
    assert.match(md, /2\. \*\*Two\*\* \(1d\)/);
    assert.doesNotMatch(md, /   - $/m);
    assert.match(md, /_via exa · 2 results_$/);
  });

  it("empty results keep the footer without a source list", () => {
    const md = formatSearchMarkdown([], "exa: 429 · bing: empty");
    assert.match(md, /No results found/);
    assert.match(md, /exa: 429/);
  });
});

describe("web-search-st reorderProvidersForFilters", () => {
  const names = (ps: SearchProvider[]) => ps.map((p) => p.name);
  const fake = (name: string): SearchProvider => ({
    name,
    isAvailable: () => true,
    search: async () => [],
  });
  const chain = ["exa", "brave", "tavily", "bing"].map(fake);

  it("leaves order alone when no filters", () => {
    assert.deepStrictEqual(names(reorderProvidersForFilters(chain, { numResults: 5 })), ["exa", "brave", "tavily", "bing"]);
  });

  it("puts filter-capable providers first for domain", () => {
    assert.deepStrictEqual(
      names(reorderProvidersForFilters(chain, { numResults: 5, domainFilter: ["docs.python.org"] })),
      ["brave", "tavily", "bing", "exa"],
    );
  });

  it("deprioritizes bing and exa for recency", () => {
    assert.deepStrictEqual(
      names(reorderProvidersForFilters(chain, { numResults: 5, recencyFilter: "week" })),
      ["brave", "tavily", "exa", "bing"],
    );
  });
});

describe("web-search-st searchWithChain filter reorder", () => {
  it("does not start at exa when domain_filter is set", async () => {
    const seen: string[] = [];
    const track = (name: string, results: SearchResult[]): SearchProvider => ({
      name,
      isAvailable: () => true,
      async search() {
        seen.push(name);
        return results;
      },
    });
    const out = await searchWithChain(
      ["q"],
      { numResults: 5, domainFilter: ["example.com"] },
      [track("exa", [mk("https://exa.example", "E")]), track("brave", [mk("https://brave.example", "B")])],
    );
    assert.deepStrictEqual(seen, ["brave"]);
    assert.strictEqual(out.providerUsed, "brave");
  });

  it("keeps a forced provider first even with filters", async () => {
    const seen: string[] = [];
    const track = (name: string, results: SearchResult[]): SearchProvider => ({
      name,
      isAvailable: () => true,
      async search() {
        seen.push(name);
        return results;
      },
    });
    const out = await searchWithChain(
      ["q"],
      { numResults: 5, domainFilter: ["example.com"], preferredProvider: "exa" },
      [track("exa", [mk("https://exa.example", "E")]), track("brave", [mk("https://brave.example", "B")])],
    );
    assert.deepStrictEqual(seen, ["exa"]);
    assert.strictEqual(out.providerUsed, "exa");
  });
});

describe("web-search-st parseJinaText", () => {
  it("strips the Markdown Content preamble", () => {
    const parsed = parseJinaText("Title: Hello\nURL Source: https://x.com\n\nMarkdown Content:\n# Hello\n\nBody");
    assert.strictEqual(parsed.title, "Hello");
    assert.strictEqual(parsed.body, "# Hello\n\nBody");
  });

  it("drops Title/URL Source lines when no Markdown Content marker", () => {
    const parsed = parseJinaText("Title: Hello\nURL Source: https://x.com\n\nThe article");
    assert.strictEqual(parsed.title, "Hello");
    assert.strictEqual(parsed.body, "The article");
  });
});

describe("web-search-st domainFilterToQuerySuffix", () => {
  it("joins multiple includes with OR, not AND", () => {
    assert.strictEqual(
      domainFilterToQuerySuffix(["github.com", "pi.dev"]),
      "(site:github.com OR site:pi.dev)",
    );
  });

  it("keeps a single include ungrouped and appends excludes", () => {
    assert.strictEqual(domainFilterToQuerySuffix(["docs.python.org"]), "site:docs.python.org");
    assert.strictEqual(
      domainFilterToQuerySuffix(["github.com", "-medium.com"]),
      "site:github.com -site:medium.com",
    );
  });

  it("drops empty tokens", () => {
    assert.strictEqual(domainFilterToQuerySuffix(["", "  ", "-"]), "");
  });
});

describe("web-search-st isExaFetchError", () => {
  it("detects Exa crawl error bodies", () => {
    assert.strictEqual(
      isExaFetchError("Error fetching URL(s): https://old.reddit.com/x: CRAWL_HTTP_403"),
      true,
    );
    assert.strictEqual(
      isExaFetchError("# Untitled\nURL: https://old.reddit.com/x\n\nError fetching URL(s): https://old.reddit.com/x: CRAWL_HTTP_403"),
      true,
    );
    assert.strictEqual(isExaFetchError("page text mentioning CRAWL_HTTP_403 in passing"), false);
    assert.strictEqual(isExaFetchError("# Title\nURL: https://a.com\n\nhello"), false);
    assert.strictEqual(isExaFetchError(""), false);
  });
});

describe("web-search-st isCloudflareChallenge", () => {
  it("flags Just a moment interstitials", () => {
    assert.strictEqual(isCloudflareChallenge(403, '<title>Just a moment...</title>'), true);
    assert.strictEqual(isCloudflareChallenge(200, "<html><title>Just a moment...</title></html>"), true);
    assert.strictEqual(isCloudflareChallenge(200, "# Real page\n\nbody"), false);
  });
});

describe("web-search-st jinaTargetError", () => {
  it("reads Warning: target HTTP errors", () => {
    const text = "Title: \nURL Source: https://x.com\nWarning: Target URL returned error 403: Forbidden\n\nMarkdown Content:\nblocked";
    assert.match(jinaTargetError(text) ?? "", /403/);
    assert.strictEqual(jinaTargetError("Title: Ok\n\nMarkdown Content:\nhello"), undefined);
  });
});

describe("web-search-st preservePlainText", () => {
  it("keeps indent and does not join source lines", () => {
    const src = "export function foo() {\n  const x = 1;\n  return x;\n}\n";
    assert.strictEqual(preservePlainText(src), src);
    assert.strictEqual(preservePlainText("a\r\nb\rc"), "a\nb\nc");
  });
});

describe("web-search-st applyOverflow", () => {
  it("returns short text unchanged", () => {
    const out = applyOverflow("hello", 100, "https://example.com/short");
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(out.content, "hello");
    assert.strictEqual(out.fullContentPath, null);
  });

  it("writes the full page and tells the agent to read it", () => {
    const full = "x".repeat(80);
    const out = applyOverflow(full, 20, "https://example.com/long-overflow-test");
    assert.strictEqual(out.truncated, true);
    assert.ok(out.fullContentPath);
    assert.match(out.content, /Returned 20 chars/);
    assert.match(out.content, /Read that file with the read tool/);
    assert.match(out.content, /Do not re-fetch this URL with a higher max_chars/);
    assert.strictEqual(readFileSync(out.fullContentPath!, "utf-8"), full);
    unlinkSync(out.fullContentPath!);
  });
});

describe("web-search-st tool rows", () => {
  const fakeTheme = {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
  } as unknown as import("@earendil-works/pi-coding-agent").Theme;

  function definitions(): Map<string, any> {
    const found = new Map<string, any>();
    const fake = new Proxy({}, {
      get: (_t, prop) => (prop === "registerTool" ? (d: any) => found.set(d.name, d) : () => {}),
    });
    webSearchFactory(fake as any);
    return found;
  }

  it("shows a muted placeholder, not a red '(no query)', while the arguments stream", () => {
    const search = definitions().get("web_search");
    const streaming = search.renderCall({}, fakeTheme, { argsComplete: false }).render(80).join("");
    assert.ok(streaming.includes("..."));
    assert.ok(!streaming.includes("no query"));

    const complete = search.renderCall({}, fakeTheme, { argsComplete: true }).render(80).join("");
    assert.ok(complete.includes("no query"));

    const fetch = definitions().get("fetch_content");
    assert.ok(fetch.renderCall({}, fakeTheme, { argsComplete: false }).render(80).join("").includes("..."));
  });

  it("keeps one progress line while the call runs (no 0 -> N jump)", () => {
    const defs = definitions();
    const running = defs.get("web_search")
      .renderResult(
        { content: [{ type: "text", text: 'Searching: "q"...' }], details: { phase: "search" } },
        { expanded: false, isPartial: true },
        fakeTheme,
      )
      .render(80)
      .join("");
    assert.ok(running.includes("searching"));

    const fetching = defs.get("fetch_content")
      .renderResult({ content: [], details: { phase: "fetch" } }, { expanded: false, isPartial: true }, fakeTheme)
      .render(80)
      .join("");
    assert.ok(fetching.includes("fetching"));
  });

  it("flags a failed call as an error result", async () => {
    const defs = definitions();
    const noQuery = await defs.get("web_search").execute("t1", {}, undefined, undefined, {});
    assert.strictEqual(noQuery.isError, true);
    const noUrl = await defs.get("fetch_content").execute("t1", {}, undefined, undefined, {});
    assert.strictEqual(noUrl.isError, true);
  });
});
