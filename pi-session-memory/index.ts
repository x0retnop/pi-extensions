import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { exportSessionToMarkdown, type ExportFormat } from "./local-export.js";
import {
  ANNOTATE_SENTINEL,
  buildAnnotationPrompt,
  parseAnnotationReply,
  writeSessionNote,
  type ParsedAnnotation,
} from "./session-note.js";
import {
  buildChatPreview,
  hasChildSessionDirs,
  listScopedSessions,
  listSessionProjects,
  readSessionMeta,
  type BrowserScope,
} from "./local-sessions.js";
import { extractProject, extractProjectFromSessionFile, isDifferentProject } from "./project.js";
import {
  browseItemFromMeta,
  browseItemFromProject,
  openSessionBrowser,
  type BrowseItem,
  type BrowserAction,
} from "./session-browser.js";
import type { ViewerAction } from "./session-viewer.js";

export default function (pi: ExtensionAPI) {
  // ---------------------------------------------------------------------------
  // Human UI — local browser (/sw) + hub (/sm). Local only: no index, no backend.
  // ---------------------------------------------------------------------------

  async function showMainMenu(ctx: any) {
    if (!ctx.hasUI) {
      pi.sendMessage(
        {
          customType: "session-memory",
          content: "Error: /sm requires interactive UI.",
          display: true,
        },
        { triggerTurn: false },
      );
      return;
    }

    const choice = await ctx.ui.select("Session memory", [
      "[1] Open session",
      "[2] Export session to Markdown",
      "[3] Annotate current session (title + summary)",
    ]);

    if (!choice) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const idxMatch = choice.match(/^\[(\d+)\]/);
    const idx = idxMatch ? parseInt(idxMatch[1], 10) : -1;

    switch (idx) {
      case 1:
        await runSessions(ctx);
        break;
      case 2:
        await runExport(ctx);
        break;
      case 3:
        annotateCurrentSession(ctx);
        break;
      default:
        ctx.ui.notify("Unknown choice", "error");
    }
  }

  function loadBrowserItems(ctx: any, scope: BrowserScope): BrowseItem[] {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const active = ctx.sessionManager.getSessionFile?.() as string | undefined;
    if (scope === "projects") {
      return listSessionProjects().map(browseItemFromProject);
    }
    const metas = listScopedSessions({
      cwd,
      scope,
      limit: 80,
      excludeSourcePath: active,
    });
    return metas.map(browseItemFromMeta);
  }

  function loadProjectSessions(ctx: any, item: BrowseItem): BrowseItem[] {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const active = ctx.sessionManager.getSessionFile?.() as string | undefined;
    const metas = listScopedSessions({
      cwd: item.project || cwd,
      scope: "current",
      dirName: item.dirName,
      limit: 80,
      excludeSourcePath: active,
    });
    return metas.map(browseItemFromMeta);
  }

  /**
   * Local-first session picker. Enter = true switchSession (not inject).
   * Default scope = project tree; Tab cycles project → current → by project → all.
   */
  async function runSessions(ctx: any) {
    if (!ctx.hasUI) {
      ctx.ui?.notify?.("/sw requires interactive UI", "error");
      return;
    }

    let scope: BrowserScope = "project";
    let drill: BrowseItem | undefined;
    const skipCurrentScope = !hasChildSessionDirs(ctx.cwd || ctx.sessionManager.getCwd());
    // Stay in the loop after preview/export so one /sw covers several looks.
    // Open exits (session replaced). Cancel exits.
    for (;;) {
      const items = drill
        ? loadProjectSessions(ctx, drill)
        : loadBrowserItems(ctx, scope);
      const picked = await openSessionBrowser({
        ui: ctx.ui,
        title: "Open session",
        items,
        mode: "open",
        scope,
        skipCurrentScope,
        drilledProject: drill,
        onScopeChange: (next) => {
          scope = next;
          drill = undefined;
          return loadBrowserItems(ctx, next);
        },
        onProjectOpen: (item) => {
          drill = item;
          return loadProjectSessions(ctx, item);
        },
        onDrillBack: () => {
          drill = undefined;
          return loadBrowserItems(ctx, "projects");
        },
        onDelete: (item) => deleteSessionItem(ctx, item),
      });

      if (!picked) return;

      const cont = await handleBrowserAction(ctx, picked.item, picked.action);
      if (!cont) return;
    }
  }

  async function viewSessionLocal(ctx: any, sourcePath: string): Promise<ViewerAction> {
    const { openSessionViewer } = await import("./session-viewer.js");
    const preview = buildChatPreview(sourcePath);
    return openSessionViewer({
      ui: ctx.ui,
      sourcePath,
      project: preview.project || extractProject(sourcePath),
      date: preview.date || "",
      meta: preview.meta,
      messages: preview.messages,
      note: preview.note,
    });
  }

  /** @returns true = stay in browser loop; false = stop (opened or fatal). */
  async function handleBrowserAction(ctx: any, item: BrowseItem, action: BrowserAction): Promise<boolean> {
    if (item.kind === "project") return true;
    switch (action) {
      case "preview": {
        const viewerAction = await viewSessionLocal(ctx, item.source_path);
        return handleViewerAction(ctx, item.source_path, viewerAction);
      }
      case "open":
        await openSessionFile(ctx, item.source_path);
        return false;
      case "export":
        await runExportFromItem(ctx, item.source_path);
        return true;
      case "delete":
        // Inline in browser.
        return true;
      default:
        return true;
    }
  }

  /** @returns true = back to browser; false = stop. */
  async function handleViewerAction(ctx: any, sourcePath: string, viewerAction: ViewerAction): Promise<boolean> {
    switch (viewerAction) {
      case "open":
        await openSessionFile(ctx, sourcePath);
        return false;
      case "export":
        await runExportFromItem(ctx, sourcePath);
        return true;
      case "back":
      default:
        return true;
    }
  }

  /**
   * Open a session file via switchSession — same runtime path as built-in
   * /resume, plus three guards:
   *  - stale list entries (file deleted since) are rejected instead of
   *    opening a phantom empty session at a dead path (which would replace
   *    the active one);
   *  - switching to a session from another project is confirmed, because it
   *    replaces the active session and jumps cwd to the target project;
   *  - MissingSessionCwdError (target session's stored cwd deleted) offers
   *    to continue in the current cwd, mirroring the built-in /resume prompt.
   */
  async function openSessionFile(ctx: any, sourcePath: string) {
    if (typeof ctx.switchSession !== "function") {
      ctx.ui.notify("switchSession is not available in this context", "error");
      return;
    }

    if (!existsSync(sourcePath)) {
      ctx.ui.notify(
        `Session file not found:\n${sourcePath}\n\nIt was deleted after the list was built — re-open /sw to refresh.`,
        "error",
      );
      return;
    }

    const currentCwd = ctx.cwd || ctx.sessionManager.getCwd();
    if (isDifferentProject(sourcePath, currentCwd)) {
      const target = extractProjectFromSessionFile(sourcePath) || extractProject(sourcePath);
      const ok = await ctx.ui.confirm(
        "Open session from another project?",
        `${path.basename(sourcePath)}\n\n${target}\n\nThe active session will be replaced and Pi switches to this project (cwd).`,
      );
      if (!ok) return;
    }

    const doSwitch = async (options?: { cwdOverride?: string }) => {
      const result = await ctx.switchSession(sourcePath, options);
      if (result?.cancelled) {
        ctx.ui.notify("Open cancelled", "info");
        return false;
      }
      return true;
    };

    try {
      if (await doSwitch()) {
        // ctx is stale after a successful switch — do not touch it.
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === "MissingSessionCwdError") {
        // Stored cwd of the target session was deleted. Built-in /resume
        // prompts; mirror that fallback here.
        const ok = await ctx.ui.confirm("Session cwd not found", `${msg}\n\nContinue in current cwd?\n${currentCwd}`);
        if (!ok) {
          ctx.ui.notify("Open cancelled", "info");
          return;
        }
        try {
          await doSwitch({ cwdOverride: currentCwd });
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          try {
            ctx.ui.notify(`Failed to open session: ${msg2}`, "error");
          } catch {
            // ctx may already be invalidated
          }
        }
        return;
      }
      try {
        ctx.ui.notify(`Failed to open session: ${msg}`, "error");
      } catch {
        // ctx may already be invalidated
      }
    }
  }

  const SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");

  async function deleteSessionFile(
    sourcePath: string,
  ): Promise<{ ok: true; method: "trash" | "unlink" } | { ok: false; error: string }> {
    if (!sourcePath.startsWith(SESSIONS_DIR + path.sep)) {
      return { ok: false, error: "Refusing to delete file outside sessions directory" };
    }

    const trashArgs = sourcePath.startsWith("-") ? ["--", sourcePath] : [sourcePath];
    try {
      const result = await pi.exec("trash", trashArgs, { timeout: 5000 });
      if (result.code === 0 || !existsSync(sourcePath)) {
        return { ok: true, method: "trash" };
      }
    } catch {
      // trash not available or failed
    }

    try {
      await unlink(sourcePath);
      return { ok: true, method: "unlink" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function deleteSessionItem(ctx: any, item: BrowseItem): Promise<{ ok: boolean; error?: string }> {
    const currentPath = ctx.sessionManager.getSessionFile();
    if (item.source_path === currentPath) {
      ctx.ui.notify("Cannot delete the currently active session", "error");
      return { ok: false, error: "Cannot delete the currently active session" };
    }

    // Confirm is inline in the browser overlay — do not call ui.confirm here.
    const result = await deleteSessionFile(item.source_path);
    if (result.ok === false) {
      ctx.ui.notify(`Failed to delete: ${result.error}`, "error");
      return { ok: false, error: result.error };
    }
    const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
    ctx.ui.notify(msg, "info");
    return { ok: true };
  }

  const EXPORT_FORMAT_OPTIONS: { id: ExportFormat; label: string }[] = [
    { id: "chat", label: "chat — only user/assistant text" },
    { id: "outline", label: "outline — dialog + full tool args; results status-only (LLM analysis)" },
    { id: "outline-reasoning", label: "outline-reasoning — outline + full model reasoning (LLM analysis)" },
    { id: "full", label: "full — tools + results (no reasoning; large results collapsible)" },
    { id: "reasoning", label: "reasoning — full + complete reasoning (separated from final answer)" },
    { id: "real-full", label: "real-full — all messages, tool calls and results untruncated" },
  ];

  async function pickExportFormat(ctx: any): Promise<ExportFormat | undefined> {
    const labels = EXPORT_FORMAT_OPTIONS.map((f, i) => `[${i + 1}] ${f.label}`);
    const choice = await ctx.ui.select("Export format", labels);
    if (!choice) return undefined;
    const idxMatch = choice.match(/^\[(\d+)\]/);
    if (!idxMatch) return undefined;
    return EXPORT_FORMAT_OPTIONS[parseInt(idxMatch[1], 10) - 1]?.id;
  }

  async function writeExport(ctx: any, sourcePath: string, format: ExportFormat) {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const result = exportSessionToMarkdown(sourcePath, format, cwd);
    if (result.ok) {
      ctx.ui.notify(
        `Exported to ${path.basename(result.path)}\n${result.entries} entries, ${result.chars} chars`,
        "info",
      );
    } else {
      ctx.ui.notify(`Export failed: ${(result as { error: string }).error}`, "error");
    }
  }

  async function runExportFromItem(ctx: any, sourcePath: string) {
    const format = await pickExportFormat(ctx);
    if (!format) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    await writeExport(ctx, sourcePath, format);
  }

  /** One-line menu label for a session: clipped title · project. */
  function exportSessionLabel(sourcePath: string): string {
    const meta = readSessionMeta(sourcePath);
    const title = meta.title || path.basename(sourcePath);
    const clipped = title.length > 50 ? title.slice(0, 49) + "…" : title;
    return `${clipped}  ·  ${meta.project || "?"}`;
  }

  async function runExport(ctx: any) {
    // Active session first (the common case); other sessions behind the same
    // browser as /sw (mode "select": Enter picks, P previews).
    const activePath = ctx.sessionManager.getSessionFile?.() as string | undefined;
    const activeExists = !!activePath && existsSync(activePath);

    const options: string[] = [];
    if (activeExists && activePath) {
      options.push(`[1] Active session — ${exportSessionLabel(activePath)}`);
    }
    options.push("[2] Choose another session…");

    const choice = await ctx.ui.select("Export session to Markdown", options);
    if (!choice) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    if (choice.startsWith("[1]") && activePath) {
      await runExportFromItem(ctx, activePath);
      return;
    }

    let scope: BrowserScope = "project";
    let drill: BrowseItem | undefined;
    const skipCurrentScope = !hasChildSessionDirs(ctx.cwd || ctx.sessionManager.getCwd());
    for (;;) {
      const items = drill
        ? loadProjectSessions(ctx, drill)
        : loadBrowserItems(ctx, scope);
      const picked = await openSessionBrowser({
        ui: ctx.ui,
        title: "Export session",
        items,
        mode: "select",
        scope,
        skipCurrentScope,
        drilledProject: drill,
        onScopeChange: (next) => {
          scope = next;
          drill = undefined;
          return loadBrowserItems(ctx, next);
        },
        onProjectOpen: (item) => {
          drill = item;
          return loadProjectSessions(ctx, item);
        },
        onDrillBack: () => {
          drill = undefined;
          return loadBrowserItems(ctx, "projects");
        },
        onDelete: (item) => deleteSessionItem(ctx, item),
      });
      if (!picked) return;

      if (picked.action === "preview") {
        const viewerAction = await viewSessionLocal(ctx, picked.item.source_path);
        if (viewerAction === "back") continue;
        if (viewerAction === "open") {
          await openSessionFile(ctx, picked.item.source_path);
          return;
        }
        // "export" from the viewer falls through to the export below.
      }

      // "select" (Enter) or "export" — pick format and write.
      await runExportFromItem(ctx, picked.item.source_path);
      // Stay in the picker for another export; Q/Esc exits.
    }
  }

  function extractMessageText(content: unknown): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
        parts.push((block as any).text);
      }
    }
    return parts.join("\n");
  }

  async function runCommandSafely(ctx: any, fn: (ctx: any) => Promise<void>) {
    try {
      await fn(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx?.hasUI) ctx.ui.notify(`session-memory error: ${msg}`, "error");
    }
  }
  // ---------------------------------------------------------------------------
  // Annotation — generated title + summary, written to the HEAD of the session file.
  // The request is a normal user turn, so the session's own model answers from its own
  // context (prompt-cache hit) and the reply stays visible in the transcript; only its
  // parsed result is persisted, plus a context edit that keeps the request/reply out of
  // later LLM calls. See session-note.ts for the storage layout.
  // ---------------------------------------------------------------------------

  /** One annotation in flight; cleared on success, failure, or timeout. */
  let annotationPending: { sessionFile: string; timer: ReturnType<typeof setTimeout> } | undefined;

  const ANNOTATE_TIMEOUT_MS = 5 * 60 * 1000;

  function currentModelLabel(ctx: any): string | undefined {
    try {
      const entries = ctx?.sessionManager?.getEntries?.() ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e?.type === "model_change" && e.provider && e.modelId) return `${e.provider}/${e.modelId}`;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  /**
   * Ids of the annotation request and its reply.
   *
   * The window closes at the next user message, and the reply is the LAST assistant entry
   * inside it: at `message_end` the reply is often not persisted yet (Pi appends it after the
   * handler returns), so the first attempt finds nothing and a retry lands with the reply —
   * by then the session may already have moved on, and only the window keeps us from hiding
   * the wrong message.
   */
  function annotationTurnEntryIds(entries: any[]): string[] {
    let requestIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type !== "message" || e.message?.role !== "user") continue;
      if (extractMessageText(e.message.content).includes(ANNOTATE_SENTINEL)) {
        requestIdx = i;
        break;
      }
    }
    if (requestIdx < 0) return [];
    let windowEnd = entries.length;
    for (let i = requestIdx + 1; i < entries.length; i++) {
      const e = entries[i];
      if (e?.type === "message" && e.message?.role === "user") {
        windowEnd = i;
        break;
      }
    }
    for (let i = windowEnd - 1; i > requestIdx; i--) {
      const e = entries[i];
      if (e?.type === "message" && e.message?.role === "assistant") return [e.id, entries[requestIdx].id];
    }
    return [];
  }

  /**
   * Keep the request and the reply visible in the TUI but out of the model context:
   * the same mechanism the built-in message editor uses. Best-effort — the entries may
   * still be flushing when the reply ends, so retry once or twice, then give up.
   */
  function hideAnnotationTurn(ctx: any, attempt = 0) {
    try {
      const sm = ctx?.sessionManager;
      if (!sm || typeof sm.appendContextEdit !== "function" || typeof sm.getEntries !== "function") return;
      const ids = annotationTurnEntryIds(sm.getEntries());
      if (ids.length === 0) {
        if (attempt < 3) setTimeout(() => hideAnnotationTurn(ctx, attempt + 1), 400);
        return;
      }
      for (const id of ids) {
        try {
          sm.appendContextEdit(id, null);
        } catch {
          // ignore
        }
      }
    } catch {
      // best-effort
    }
  }

  /** ctx goes stale after a session switch — a notify must never throw into the event handler. */
  function safeNotify(ctx: any, message: string, level: "info" | "warn" | "error") {
    try {
      ctx?.ui?.notify?.(message, level);
    } catch {
      // stale ctx — the annotation itself still landed on disk
    }
  }

  function finishAnnotation(ctx: any, parsed: ParsedAnnotation | undefined, raw: string) {
    const pending = annotationPending;
    if (!pending) return;
    clearTimeout(pending.timer);
    annotationPending = undefined;

    if (!parsed) {
      const sample = raw.replace(/\s+/g, " ").trim().slice(0, 300);
      safeNotify(ctx, `session-memory: не распознал ответ модели, аннотация не записана.\n${sample}`, "warn");
      return;
    }

    // Write the native name first: the running Pi keeps its own in-memory copy, so the
    // footer and the built-in resume list pick the title up immediately. The file entry
    // we insert below carries the same title with a timestamp the reader merges by.
    try {
      pi.setSessionName(parsed.title);
    } catch {
      // not fatal — the head entry still carries the title
    }

    const sameSession = (() => {
      try {
        return ctx?.sessionManager?.getSessionFile?.() === pending.sessionFile;
      } catch {
        return false;
      }
    })();

    const result = writeSessionNote(pending.sessionFile, {
      title: parsed.title,
      summary: parsed.summary,
      at: new Date().toISOString(),
      // Provenance only, and only when ctx still belongs to this session.
      model: sameSession ? currentModelLabel(ctx) : undefined,
    });

    if (!result.ok) {
      safeNotify(ctx, `session-memory: аннотация не записана — ${result.error}`, "error");
      return;
    }

    // Only touch the context of the session we annotated — ctx may belong to another one now.
    if (sameSession) hideAnnotationTurn(ctx);
    safeNotify(ctx, `✎ ${parsed.title}\n${parsed.summary}`, "info");
  }

  function annotateCurrentSession(ctx: any) {
    if (!ctx?.hasUI) {
      pi.sendMessage({ customType: "session-memory", content: "Аннотация требует интерактивного UI.", display: true }, { triggerTurn: false });
      return;
    }
    if (annotationPending) {
      safeNotify(ctx, "Аннотация уже выполняется — дождись ответа модели.", "warn");
      return;
    }
    const sessionFile = ctx.sessionManager?.getSessionFile?.() as string | undefined;
    if (!sessionFile || !existsSync(sessionFile)) {
      safeNotify(ctx, "Сессия ещё не записана на диск — аннотировать нечего.", "warn");
      return;
    }
    if (typeof pi.sendUserMessage !== "function") {
      safeNotify(ctx, "sendUserMessage недоступен в этом контексте.", "error");
      return;
    }

    annotationPending = {
      sessionFile,
      timer: setTimeout(() => {
        if (!annotationPending) return;
        annotationPending = undefined;
        safeNotify(ctx, "session-memory: аннотация не пришла за 5 минут — ничего не записано.", "warn");
      }, ANNOTATE_TIMEOUT_MS),
    };

    safeNotify(ctx, "Аннотирую: запрос ушёл рабочей модели, ответ появится в ленте.", "info");
    // deliverAs keeps this safe when the agent is mid-turn; idle sessions just run a turn.
    pi.sendUserMessage(buildAnnotationPrompt(), { deliverAs: "followUp" });
  }

  pi.on("message_end", (event: any, ctx: any) => {
    if (!annotationPending) return;
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    const text = extractMessageText(message.content);
    const parsed = parseAnnotationReply(text);
    if (!parsed) {
      const hasToolCalls =
        Array.isArray(message.content) && message.content.some((b: any) => b && typeof b === "object" && b.type === "toolCall");
      // An intermediate "I'll look around" step is not the answer — keep waiting.
      if (hasToolCalls) return;
      finishAnnotation(ctx, undefined, text);
      return;
    }
    finishAnnotation(ctx, parsed, text);
  });

  pi.registerShortcut("f7", {
    description: "session-memory: annotate session (title + summary)",
    handler: (ctx: any) => runCommandSafely(ctx, async () => annotateCurrentSession(ctx)),
  });

  pi.registerCommand("note", {
    description: "Annotate the current session — model writes TITLE + SUMMARY into the session head",
    handler: async (_args, ctx) => {
      await runCommandSafely(ctx, async () => annotateCurrentSession(ctx));
    },
  });



  pi.registerCommand("sm", {
    description: "Session memory hub — open a past session or export it to Markdown",
    handler: async (_args, ctx) => {
      await runCommandSafely(ctx, showMainMenu);
    },
  });

  pi.registerCommand("sw", {
    description: "Switch session (local list) — Enter opens",
    handler: async (_args, ctx) => {
      await runCommandSafely(ctx, runSessions);
    },
  });
}
