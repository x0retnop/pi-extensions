import { test } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import * as webSearch from "../../pi-web-search/index.js";
import * as projectMemory from "../../pi-project-memory/index.js";
import * as sessionMemory from "../../pi-session-memory/index.js";

// These tests start a local HTTP server on an ephemeral port and override
// BASE_URL via each module's exported setter. The 0x010 backend itself is not required.

function startMockServer(handler: (req: any, res: any) => void): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        stop: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.on("error", reject);
  });
}

async function readBody(req: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function withMockUrl(setter: (url: string) => void, port: number, fn: () => Promise<void>): Promise<void> {
  setter(`http://127.0.0.1:${port}`);
  await fn();
}

test("pi-web-search getBackendStatus reads status endpoint", async () => {
  const { port, stop } = await startMockServer((req, res) => {
    assert.strictEqual(req.url, "/api/web_research/status");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      enabled: true,
      mcp_enabled: true,
      mcp_path: "/mcp",
      mcp_transport: "streamable-http",
      provider_chain: ["exa", "brave"],
      default_provider: "exa",
      summarizer_mode: "summary",
      max_results: 20,
      fetch_max_chars: 32000,
      providers: { exa: true },
    }));
  });

  try {
    await withMockUrl(webSearch.setBaseUrl, port, async () => {
      const status = await webSearch.getBackendStatus();
      assert.ok(status);
      assert.strictEqual(status?.default_provider, "exa");
      assert.deepStrictEqual(status?.provider_chain, ["exa", "brave"]);
      assert.strictEqual(status?.fetch_max_chars, 32000);
    });
  } finally {
    await stop();
  }
});

test("pi-web-search mcpCall POSTs JSON-RPC and parses SSE response", async () => {
  const { port, stop } = await startMockServer(async (req, res) => {
    assert.strictEqual(req.url, "/mcp");
    assert.strictEqual(req.method, "POST");
    const body = JSON.parse(await readBody(req));
    assert.strictEqual(body.method, "tools/call");
    assert.strictEqual(body.params.name, "web_search");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`);
    res.end();
  });

  try {
    await withMockUrl(webSearch.setBaseUrl, port, async () => {
      const response = await webSearch.mcpCall("tools/call", { name: "web_search", arguments: { query: "test" } });
      assert.strictEqual(response.result?.content?.[0].text, "ok");
    });
  } finally {
    await stop();
  }
});

test("pi-project-memory apiPost sends project memory add request", async () => {
  const { port, stop } = await startMockServer(async (req, res) => {
    assert.strictEqual(req.url, "/api/project_memory/add");
    const body = JSON.parse(await readBody(req));
    assert.strictEqual(body.project_id, "my_project");
    assert.strictEqual(body.category, "facts");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, item_id: "fact-123" }));
  });

  try {
    await withMockUrl(projectMemory.setBaseUrl, port, async () => {
      const result = await projectMemory.apiPost("/api/project_memory/add", {
        project_id: "my_project",
        category: "facts",
        type: "decision",
        topic: "test",
        what: "test fact",
      });
      assert.strictEqual(result.item_id, "fact-123");
    });
  } finally {
    await stop();
  }
});

test("pi-session-memory apiSearch returns hits", async () => {
  const { port, stop } = await startMockServer(async (req, res) => {
    assert.strictEqual(req.url, "/api/session_index/search");
    const body = JSON.parse(await readBody(req));
    assert.strictEqual(body.query, "auth");
    assert.strictEqual(body.limit, 3);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hits: [{ item_id: "hit-1", source_path: "C:/sessions/a.jsonl", text: "auth flow", score: 0.85, date: "2026-06-22" }] }));
  });

  try {
    await withMockUrl(sessionMemory.setBaseUrl, port, async () => {
      const hits = await sessionMemory.apiSearch("auth", 3);
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(hits[0].item_id, "hit-1");
    });
  } finally {
    await stop();
  }
});

test("pi-session-memory apiSessionContent returns session text", async () => {
  const { port, stop } = await startMockServer(async (req, res) => {
    assert.strictEqual(req.url, "/api/session_index/session_content");
    const body = JSON.parse(await readBody(req));
    assert.strictEqual(body.source_path, "C:/sessions/a.jsonl");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ source_path: "C:/sessions/a.jsonl", project: "pi", date: "2026-06-22", text: "hello", total_messages: 10, returned_messages: 5, chars: 5, truncated: false }));
  });

  try {
    await withMockUrl(sessionMemory.setBaseUrl, port, async () => {
      const result = await sessionMemory.apiSessionContent("C:/sessions/a.jsonl", 30, 4000, 1000);
      assert.strictEqual(result.text, "hello");
      assert.strictEqual(result.total_messages, 10);
    });
  } finally {
    await stop();
  }
});

test("pi-session-memory apiStatus returns backend status", async () => {
  const { port, stop } = await startMockServer((req, res) => {
    assert.strictEqual(req.url, "/api/session_index/status");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ enabled: true, indexed_count: 42 }));
  });

  try {
    await withMockUrl(sessionMemory.setBaseUrl, port, async () => {
      const status = await sessionMemory.apiStatus();
      assert.strictEqual(status.enabled, true);
      assert.strictEqual(status.indexed_count, 42);
    });
  } finally {
    await stop();
  }
});

test("pi-session-memory apiListSessions returns session list", async () => {
  const { port, stop } = await startMockServer(async (req, res) => {
    assert.strictEqual(req.url, "/api/session_index/list");
    const body = JSON.parse(await readBody(req));
    assert.strictEqual(body.scope, "current");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [{ source_path: "C:/sessions/a.jsonl", project: "pi", date: "2026-06-22" }] }));
  });

  try {
    await withMockUrl(sessionMemory.setBaseUrl, port, async () => {
      const sessions = await sessionMemory.apiListSessions("project", "C:/10x001/project", 50);
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].project, "pi");
    });
  } finally {
    await stop();
  }
});
