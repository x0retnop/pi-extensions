import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  SelectList,
  type SelectItem,
  Text,
  matchesKey,
} from "@earendil-works/pi-tui";
import {
  buildSessionDescription,
  buildSessionLabel,
  buildSessionSearchEntries,
  filterSessionEntries,
  parseLimit,
  shouldListAllSessions,
  type SessionInfoLike,
} from "./sessions.js";

const DEFAULT_VISIBLE = 5;
const LOAD_BATCH = 5;
const SNIPPET_MAX = 60;
const SESSION_HEADER_READ_BYTES = 96 * 1024;

type SessionFileRef = {
  path: string;
  sortKey: string;
};

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notify(ctx: { hasUI?: boolean; ui?: { notify?: (message: string, level: string) => void } }, message: string, level = "info"): void {
  const text = `[sessions] ${message}`;
  if (ctx.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(text, level);
    return;
  }
  const log = level === "error" ? console.error : console.log;
  log(text);
}

const isPrintable = (data: string): boolean => {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 32 && code !== 127;
};

const formatPlainLine = (session: SessionInfoLike): string => {
  const label = buildSessionLabel(session);
  const description = buildSessionDescription(session, SNIPPET_MAX);
  return `${label}\t${description}`;
};

function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR || process.env.TAU_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === "~") return os.homedir();
    if (envDir.startsWith("~/") || envDir.startsWith("~\\")) return path.join(os.homedir(), envDir.slice(2));
    return envDir;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

function getSessionsRoot(): string {
  return path.join(getAgentDir(), "sessions");
}

function getDefaultSessionDir(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(getSessionsRoot(), safePath);
}

async function safeReaddir(dir: string, options?: { withFileTypes?: false }): Promise<string[]>;
async function safeReaddir(dir: string, options: { withFileTypes: true }): Promise<import("node:fs").Dirent[]>;
async function safeReaddir(dir: string, options?: { withFileTypes?: boolean }): Promise<any[]> {
  try {
    return await fs.readdir(dir, options as any);
  } catch {
    return [];
  }
}

function fileSortKey(filePath: string): string {
  // Pi session filenames start with an ISO-like timestamp, so filename order is a
  // cheap approximation of recency and avoids reading every session file up front.
  return path.basename(filePath);
}

async function collectSessionFileRefs(cwd: string, includeAll: boolean): Promise<SessionFileRef[]> {
  const dirs = includeAll
    ? (await safeReaddir(getSessionsRoot(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(getSessionsRoot(), entry.name))
    : [getDefaultSessionDir(cwd)];

  const perDir = await Promise.all(
    dirs.map(async (dir) => {
      const files = await safeReaddir(dir);
      return files
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => {
          const filePath = path.join(dir, name);
          return { path: filePath, sortKey: fileSortKey(filePath) };
        });
    }),
  );

  return perDir.flat().sort((a, b) => b.sortKey.localeCompare(a.sortKey));
}

function parseTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && (block as any).type === "text")
    .map((block) => String((block as any).text ?? ""))
    .join(" ");
}

function parseSessionPreview(filePath: string, text: string, modified: Date): SessionInfoLike | null {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;

  let header: any;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }

  if (header?.type !== "session" || typeof header.id !== "string") return null;

  let firstMessage = "";
  let name: string | undefined;
  for (const line of lines.slice(1)) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "session_info") {
        const trimmed = entry?.name?.trim?.();
        if (trimmed) name = trimmed;
      }
      if (!firstMessage && entry?.type === "message" && entry?.message?.role === "user") {
        firstMessage = parseTextContent(entry.message.content).trim();
      }
      if (firstMessage && name) break;
    } catch {
      // Ignore malformed preview lines.
    }
  }

  return {
    id: header.id,
    name,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    modified,
    firstMessage: firstMessage || "(no messages)",
    path: filePath,
  };
}

async function readSessionPreview(ref: SessionFileRef): Promise<SessionInfoLike | null> {
  let handle: fs.FileHandle | undefined;
  try {
    const stats = await fs.stat(ref.path);
    handle = await fs.open(ref.path, "r");
    const buffer = Buffer.alloc(Math.min(SESSION_HEADER_READ_BYTES, Math.max(1, stats.size)));
    const read = await handle.read(buffer, 0, buffer.length, 0);
    return parseSessionPreview(ref.path, buffer.toString("utf8", 0, read.bytesRead), stats.mtime);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function loadSessionBatch(refs: SessionFileRef[], start: number, count: number): Promise<SessionInfoLike[]> {
  const slice = refs.slice(start, start + count);
  const loaded = await Promise.all(slice.map(readSessionPreview));
  return loaded.filter((session): session is SessionInfoLike => session !== null);
}

async function listSessionsPlain(ctx: ExtensionCommandContext, includeAll: boolean): Promise<SessionInfoLike[]> {
  const refs = await collectSessionFileRefs(ctx.cwd, includeAll);
  const sessions: SessionInfoLike[] = [];
  for (let offset = 0; offset < refs.length; offset += 50) {
    sessions.push(...await loadSessionBatch(refs, offset, 50));
  }
  return sessions;
}

async function showSessionPicker(
  ctx: ExtensionCommandContext,
  refs: SessionFileRef[],
  maxVisible: number,
): Promise<SessionInfoLike | null> {
  return ctx.ui.custom<SessionInfoLike | null>((tui, theme, _kb, done) => {
    let filter = "";
    let loadedCount = 0;
    let loading = false;
    let loadError: string | undefined;
    let sessions: SessionInfoLike[] = [];
    let selectList: SelectList;
    const container = new Container();

    const hasMore = () => loadedCount < refs.length;

    const buildItems = (): SelectItem[] => {
      const entries = buildSessionSearchEntries(sessions);
      const filtered = filterSessionEntries(entries, filter);
      const items = filtered.map((entry) => ({
        value: entry.session.path,
        label: buildSessionLabel(entry.session),
        description: buildSessionDescription(entry.session, SNIPPET_MAX),
      }));

      if (!filter && hasMore()) {
        items.push({
          value: "__sessions_load_more__",
          label: loading ? "Loading..." : `Load ${Math.min(LOAD_BATCH, refs.length - loadedCount)} more`,
          description: `${loadedCount}/${refs.length} loaded`,
        });
      }

      return items;
    };

    const rebuild = (selectedIndex?: number) => {
      const items = buildItems();
      const visible = Math.max(1, Math.min(maxVisible, Math.max(items.length, 1)));

      selectList = new SelectList(items, visible, {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: () => theme.fg("warning", loading ? "  Loading sessions..." : "  No matching sessions"),
      });
      if (selectedIndex !== undefined) selectList.setSelectedIndex(selectedIndex);

      selectList.onSelect = (item) => {
        if (item.value === "__sessions_load_more__") {
          void loadMore(true);
          return;
        }
        const session = sessions.find((candidate) => candidate.path === item.value) ?? null;
        done(session);
      };
      selectList.onCancel = () => done(null);

      const filterLine = filter.length
        ? `${theme.fg("muted", "Filter: ")}${theme.fg("text", filter)}`
        : `${theme.fg("muted", "Filter: ")}${theme.fg("dim", "type to filter")}`;
      const loadLine = loadError
        ? theme.fg("error", loadError)
        : theme.fg("dim", hasMore() ? `${loadedCount}/${refs.length} loaded · ↓ at bottom loads more` : `${loadedCount}/${refs.length} loaded`);

      container.clear();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Sessions")), 1, 0));
      container.addChild(new Text(filterLine, 1, 0));
      container.addChild(new Text(loadLine, 1, 0));
      container.addChild(selectList);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter open/load • esc cancel"), 1, 0));
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    };

    const loadMore = async (keepAtBottom = false) => {
      if (loading || !hasMore()) return;
      loading = true;
      loadError = undefined;
      const previousSelected = (selectList as any)?.selectedIndex ?? 0;
      rebuild(previousSelected);
      tui.requestRender();

      try {
        const batch = await loadSessionBatch(refs, loadedCount, LOAD_BATCH);
        loadedCount = Math.min(refs.length, loadedCount + LOAD_BATCH);
        sessions = sessions.concat(batch);
      } catch (err) {
        loadError = formatError(err);
      } finally {
        loading = false;
        rebuild(keepAtBottom ? Math.max(0, Math.min(previousSelected, buildItems().length - 1)) : previousSelected);
        tui.requestRender();
      }
    };

    void loadMore(false);
    rebuild();

    return {
      render: (width) => container.render(width),
      invalidate: () => {
        rebuild((selectList as any)?.selectedIndex ?? 0);
        container.invalidate();
      },
      handleInput: (data) => {
        if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
          if (filter.length > 0) {
            filter = filter.slice(0, -1);
            rebuild(0);
            tui.requestRender();
          }
          return;
        }

        if (isPrintable(data)) {
          filter += data;
          rebuild(0);
          tui.requestRender();
          return;
        }

        const beforeIndex = (selectList as any)?.selectedIndex ?? 0;
        const beforeItem = selectList.getSelectedItem();
        if (!filter && hasMore() && !loading && matchesKey(data, Key.down) && beforeItem?.value === "__sessions_load_more__") {
          void loadMore(true);
          return;
        }

        selectList.handleInput(data);

        const afterItem = selectList.getSelectedItem();
        if (!filter && hasMore() && !loading && afterItem?.value === "__sessions_load_more__" && beforeIndex < ((selectList as any)?.selectedIndex ?? 0)) {
          void loadMore(true);
          return;
        }

        tui.requestRender();
      },
    };
  });
}

async function runSessionsCommand(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
  const limit = parseLimit(args, DEFAULT_VISIBLE);
  const includeAll = shouldListAllSessions(args);
  const refs = await collectSessionFileRefs(ctx.cwd, includeAll);

  if (refs.length === 0) {
    notify(ctx, "No sessions found for this project.", "info");
    return;
  }

  if (!ctx.hasUI) {
    const sessions = await listSessionsPlain(ctx, includeAll);
    for (const session of sessions) {
      console.log(formatPlainLine(session));
    }
    return;
  }

  const selection = await showSessionPicker(ctx, refs, limit);
  if (!selection) return;

  const result = await ctx.switchSession(selection.path);
  if (result.cancelled) {
    notify(ctx, "Session switch cancelled.", "info");
  }
}

export default function sessionsExtension(pi: ExtensionAPI) {
  pi.registerCommand("sessions", {
    description: "Pick a session from the current project; use /sessions all for every project",
    handler: async (args, ctx) => {
      try {
        await runSessionsCommand(args, ctx);
      } catch (err) {
        notify(ctx, formatError(err), "error");
      }
    },
  });
}
