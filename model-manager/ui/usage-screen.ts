import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { CachedModel, UsagePinnedWindow } from "../types.js";
import type { ProviderUsage, UsageDeltas, UsageHistoryEntry, UsageWindowSnapshotEntry } from "../usage.js";
import {
  buildProviderUsageFromSnapshot,
  buildSparkline,
  clearUsageHistory,
  clearUsageSnapshot,
  computeBurnProjection,
  computeUsageDeltas,
  estimateUsageCost,
  getKimiCalibStats,
  WEEKLY_LIMIT_LABEL,
  fetchActiveProviderUsage,
  fetchAllUsage,
  formatBurnProjection,
  formatCompact,
  formatCost,
  loadPinnedWindow,
  loadUsageHistory,
  loadUsageSnapshot,
  mergeSnapshot,
  recordUsageHistory,
  savePinnedWindow,
  saveUsageSnapshot,
} from "../usage.js";

export interface UsageScreenState {
  usages: ProviderUsage[];
  snapshot: UsageWindowSnapshotEntry[];
  history: UsageHistoryEntry[];
  pinnedKey?: string;
}

export interface UsageController {
  state: UsageScreenState;
  refreshActive: () => Promise<void>;
  refreshAll: () => Promise<void>;
  setPinned: (key: string | undefined) => void;
}

export async function createUsageController(
  ctx: ExtensionContext | ExtensionCommandContext,
): Promise<UsageController> {
  const model = ctx.model;
  if (!model) {
    throw new Error("No model selected — usage shows the active provider.");
  }
  const providerId = model.provider;
  const snapshot = loadUsageSnapshot();
  const pinned = loadPinnedWindow();
  const active = await fetchActiveProviderUsage(ctx);
  const usages: ProviderUsage[] = [];
  let history = loadUsageHistory();

  if (active.usage) {
    usages.push(active.usage);
    history = recordUsageHistory([active.usage]);
  } else if (active.error) {
    usages.push({
      providerId,
      displayName: ctx.modelRegistry.getProviderDisplayName(providerId) || providerId,
      fetchedAt: new Date().toISOString(),
      error: active.error,
      source: "live",
      windows: [],
    });
  }

  const liveProviderIds = new Set(usages.map((u) => u.providerId));
  const cached = buildProviderUsageFromSnapshot(snapshot).filter((u) => !liveProviderIds.has(u.providerId));
  usages.push(...cached);

  const state: UsageScreenState = {
    usages,
    snapshot,
    history,
    pinnedKey: pinned ? `${pinned.providerId}::${pinned.label}` : undefined,
  };

  async function refreshActive(): Promise<void> {
    const result = await fetchActiveProviderUsage(ctx);
    if (result.usage) {
      state.history = recordUsageHistory([result.usage]);
      const idx = state.usages.findIndex((u) => u.providerId === result.providerId);
      if (idx >= 0) {
        state.usages[idx] = result.usage;
      } else {
        state.usages.unshift(result.usage);
      }
    } else if (result.error) {
      const idx = state.usages.findIndex((u) => u.providerId === result.providerId);
      if (idx >= 0) {
        state.usages[idx] = {
          providerId: result.providerId,
          displayName: ctx.modelRegistry.getProviderDisplayName(result.providerId) || result.providerId,
          fetchedAt: new Date().toISOString(),
          error: result.error,
          source: "live",
          windows: [],
        };
      }
    }
    state.snapshot = mergeSnapshot(state.snapshot, state.usages);
  }

  async function refreshAll(): Promise<void> {
    const all = await fetchAllUsage(ctx);
    state.history = recordUsageHistory(all);
    const providerIds = new Set(all.map((u) => u.providerId));
    state.usages = [
      ...all,
      ...state.usages.filter((u) => !providerIds.has(u.providerId)),
    ];
    state.snapshot = mergeSnapshot(state.snapshot, state.usages);
  }

  function setPinned(key: string | undefined): void {
    state.pinnedKey = key;
    let parsed: UsagePinnedWindow | undefined;
    if (key) {
      const [providerId, ...labelParts] = key.split("::");
      const label = labelParts.join("::");
      if (providerId && label) parsed = { providerId, label };
    }
    savePinnedWindow(parsed);
  }

  return { state, refreshActive, refreshAll, setPinned };
}

export function saveUsageState(state: UsageScreenState): void {
  saveUsageSnapshot(mergeSnapshot(state.snapshot, state.usages));
}

interface MergedRow {
  providerId: string;
  displayName: string;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  resetHint?: string;
  fetchedAt: string;
  source: "live" | "snapshot";
  error?: string;
  rawResponse?: unknown;
  /** Consumption deltas vs rolling history (previous fetch / first fetch today). */
  deltas?: UsageDeltas;
}

interface InspectState {
  lines: string[];
  offset: number;
}
type HistoryViewMode = "window" | "provider";

interface HistoryViewState {
  providerId: string;
  displayName: string;
  label: string;
  mode: HistoryViewMode;
  groupByDay: boolean;
  offset: number;
}
interface ClearHistoryConfirmState {
  providerId: string;
  displayName: string;
  label: string;
  clearProvider: boolean;
}

const HISTORY_VIEW_MAX = 16;

interface HistoryListItem {
  time: string;
  label?: string;
  used: number;
  limit: number;
  remaining: number;
  delta?: number;
  week?: number;
}

export class UsageSubview implements Component {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private onBack: () => void;
  private screen: UsageScreen | undefined;
  private loading = true;
  private error?: string;

  constructor(
    tui: TUI,
    theme: Theme,
    kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    onBack: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.onBack = onBack;
    createUsageController(ctx)
      .then((controller) => {
        this.loading = false;
        this.screen = new UsageScreen(
          tui,
          theme,
          kb,
          ctx,
          controller.state,
          controller.refreshActive,
          controller.refreshAll,
          controller.setPinned,
          () => this.onBack(),
        );
        this.tui.requestRender();
      })
      .catch((err) => {
        this.loading = false;
        this.error = err instanceof Error ? err.message : String(err);
        this.ctx.ui.notify(this.error, "warning");
        this.tui.requestRender();
      });
  }

  invalidate(): void {
    this.screen?.invalidate();
  }

  render(width: number): string[] {
    if (this.loading) {
      return [
        truncateToWidth(this.theme.fg("accent", this.theme.bold("Model Manager > Usage")), width),
        "",
        this.theme.fg("dim", "  Loading usage data..."),
      ];
    }
    if (this.error || !this.screen) {
      return [
        truncateToWidth(this.theme.fg("accent", this.theme.bold("Model Manager > Usage")), width),
        "",
        this.theme.fg("error", `  ${this.error ?? "Failed to load usage"}`),
        "",
        this.theme.fg("dim", "  Press Esc to go back"),
      ];
    }
    return this.screen.render(width);
  }

  handleInput(data: string): void {
    if (this.loading) {
      if (data === "\x1b" || data === "q" || data === "Q") {
        this.onBack();
      }
      return;
    }
    if (!this.screen) {
      this.onBack();
      return;
    }
    this.screen.handleInput(data);
  }
}


export class UsageScreen implements Component {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private state: UsageScreenState;
  private onClose: () => void;
  private onRefreshActive: () => Promise<void>;
  private onFetchAll: () => Promise<void>;
  private onPin: (key: string | undefined) => void;
  private rows: MergedRow[] = [];
  private selectedIndex = 0;
  private cachedLines: string[] | undefined;
  private cachedWidth = 0;
  private refreshing = false;
  private inspect: InspectState | undefined;
  private confirmClearFor?: ClearHistoryConfirmState;
  private historyView: HistoryViewState | undefined;

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    state: UsageScreenState,
    onRefreshActive: () => Promise<void>,
    onFetchAll: () => Promise<void>,
    onPin: (key: string | undefined) => void,
    onClose: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.state = state;
    this.onRefreshActive = onRefreshActive;
    this.onFetchAll = onFetchAll;
    this.onPin = onPin;
    this.onClose = onClose;
    this.rebuildRows();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = 0;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines && !this.inspect && !this.historyView) {
      return this.cachedLines;
    }

    if (this.inspect) {
      const lines = this.renderInspect(width);
      this.cachedLines = lines;
      this.cachedWidth = width;
      return lines;
    }

    if (this.historyView) {
      const lines = this.renderHistoryView(width);
      this.cachedLines = lines;
      this.cachedWidth = width;
      return lines;
    }

    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Model Manager > Usage")), width));
    lines.push(this.theme.fg("dim", "  " + (this.refreshing ? "Fetching..." : "Quota usage per provider")));
    lines.push("");

    if (this.rows.length === 0) {
      lines.push(this.theme.fg("dim", "  No usage data. Run /usage to refresh."));
    } else {
      // Window labels are aligned per render so bars form a clean column.
      const labelWidth = Math.min(
        20,
        Math.max(...this.rows.map((r) => (r.error ? 0 : r.label.length)), 0),
      );
      // Rows arrive grouped by provider (see rebuildRows); print the provider
      // header once per group instead of repeating it on every window row.
      let lastProviderId: string | undefined;
      for (let i = 0; i < this.rows.length; i++) {
        const row = this.rows[i];
        if (row.providerId !== lastProviderId) {
          lastProviderId = row.providerId;
          lines.push(this.renderProviderHeader(row, width));
        }
        lines.push(...this.renderRow(row, i === this.selectedIndex, width, labelWidth));
      }
      lines.push("");
    }

    if (this.confirmClearFor) {
      const target = this.confirmClearFor.clearProvider
        ? this.confirmClearFor.displayName
        : `${this.confirmClearFor.displayName} · ${this.confirmClearFor.label}`;
      const key = this.confirmClearFor.clearProvider ? "x" : "d";
      lines.push("");
      lines.push(this.theme.fg("warning", `  Press ${key} again (or Enter/y) to clear ${target}, Esc to cancel`));
    }

    lines.push("");
    const footer = this.refreshing
      ? "please wait..."
      : "↑↓ move · r refresh active · R refresh all · p pin/unpin · h history · i inspect · d clear window · x clear provider · Esc/q close";
    lines.push(truncateToWidth(this.theme.fg("dim", footer), width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  handleInput(data: string): void {
    if (this.inspect) {
      this.handleInspectInput(data);
      return;
    }
    if (this.historyView) {
      this.handleHistoryInput(data);
      return;
    }

    const kb = getKeybindings();
    if (this.refreshing) {
      return;
    }

    if (this.confirmClearFor) {
      const expected = this.confirmClearFor.clearProvider ? "x" : "d";
      if (data === expected || data === "\r" || data === "\n" || data === "y" || data === "Y") {
        this.executeClearHistory();
      } else if (kb.matches(data, "tui.select.cancel")) {
        this.confirmClearFor = undefined;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? this.rows.length - 1 : this.selectedIndex - 1;
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === this.rows.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "Q") {
      this.onClose();
      return;
    } else if (data === "r" || data === "R") {
      if (data === "R") {
        this.runRefresh(this.onFetchAll);
      } else {
        this.runRefresh(this.onRefreshActive);
      }
      return;
    } else if (data === "p" || data === "P") {
      this.togglePin();
      return;
    } else if (data === "i" || data === "I") {
      this.openInspect();
      return;
    } else if (data === "d") {
      this.promptClearHistory(false);
      return;
    } else if (data === "x") {
      this.promptClearHistory(true);
      return;
    } else if (data === "h" || data === "H") {
      this.openHistoryView();
      return;
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private async runRefresh(refresh: () => Promise<void>): Promise<void> {
    this.refreshing = true;
    this.invalidate();
    this.tui.requestRender();
    try {
      await refresh();
    } catch (err) {
      console.error(`[model-manager] usage refresh failed: ${err}`);
    } finally {
      this.refreshing = false;
      this.rebuildRows();
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private togglePin(): void {
    const row = this.rows[this.selectedIndex];
    if (!row || row.error) return;
    const key = `${row.providerId}::${row.label}`;
    if (this.state.pinnedKey === key) {
      this.state.pinnedKey = undefined;
      this.onPin(undefined);
    } else {
      this.state.pinnedKey = key;
      this.onPin(key);
    }
    this.rebuildRows();
    this.invalidate();
    this.tui.requestRender();
  }

  private promptClearHistory(clearProvider: boolean): void {
    const row = this.rows[this.selectedIndex];
    if (!row || row.error) return;
    this.confirmClearFor = {
      providerId: row.providerId,
      displayName: row.displayName,
      label: row.label,
      clearProvider,
    };
    this.invalidate();
    this.tui.requestRender();
  }

  private executeClearHistory(): void {
    const target = this.confirmClearFor;
    if (!target) return;
    this.state.history = clearUsageHistory(target.providerId, target.clearProvider ? undefined : target.label);
    if (target.clearProvider) {
      this.state.snapshot = clearUsageSnapshot(target.providerId);
      this.state.usages = this.state.usages.filter((u) => u.providerId !== target.providerId);
    }
    this.confirmClearFor = undefined;
    this.rebuildRows();
    this.invalidate();
    this.tui.requestRender();
    this.ctx.ui.notify(
      `Usage ${target.clearProvider ? "provider" : "window"} cleared for ${target.clearProvider ? target.displayName : `${target.displayName} · ${target.label}`}`,
      "info",
    );
  }

  private openInspect(): void {
    const row = this.rows[this.selectedIndex];
    if (!row) return;
    const pu = this.state.usages.find((u) => u.providerId === row.providerId);
    if (!pu || pu.rawResponse === undefined) return;
    const json = JSON.stringify(pu.rawResponse, null, 2);
    const head: string[] = [];
    const modelId = this.ctx.model?.id;
    const stats = getKimiCalibStats(row.providerId, modelId) ?? getKimiCalibStats(row.providerId);
    if (stats) {
      const label = modelId ?? "blend";
      const asOf = stats.lastAt ? `  as of ${stats.lastAt.slice(0, 10)}` : "";
      head.push(`calib ${label}  ${stats.pairs} pairs  ${formatCost(stats.dollarsPerUnit)}/1%  Σdq=${formatCompact(stats.totalQuota)}${asOf}`);
      head.push("");
    }
    this.inspect = {
      lines: [...head, ...json.split("\n")],
      offset: 0,
    };
    this.invalidate();
    this.tui.requestRender();
  }

  private openHistoryView(): void {
    const row = this.rows[this.selectedIndex];
    if (!row || row.error) return;
    this.historyView = {
      providerId: row.providerId,
      displayName: row.displayName,
      label: row.label,
      mode: "window",
      groupByDay: false,
      offset: 0,
    };
    this.invalidate();
    this.tui.requestRender();
  }

  private collectHistoryItems(view: HistoryViewState): HistoryListItem[] {
    const filtered = this.state.history
      .filter((e) => e.providerId === view.providerId && (view.mode === "provider" || e.label === view.label))
      .sort((a, b) => new Date(a.fetchedAt).getTime() - new Date(b.fetchedAt).getTime());
    const showLabel = view.mode === "provider";
    const items: HistoryListItem[] = [];

    const weekOf = (used: number, fetchedAt: string, label: string): number | undefined =>
      computeUsageDeltas(this.state.history, view.providerId, label, used, fetchedAt).week;

    if (view.groupByDay) {
      const byDay = new Map<string, Map<string, UsageHistoryEntry[]>>();
      for (const e of filtered) {
        const day = this.formatDate(new Date(e.fetchedAt));
        let dayMap = byDay.get(day);
        if (!dayMap) {
          dayMap = new Map<string, UsageHistoryEntry[]>();
          byDay.set(day, dayMap);
        }
        let list = dayMap.get(e.label);
        if (!list) {
          list = [];
          dayMap.set(e.label, list);
        }
        list.push(e);
      }
      for (const [day, dayMap] of Array.from(byDay.entries()).sort((a, b) => b[0].localeCompare(a[0]))) {
        for (const [label, list] of Array.from(dayMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
          const first = list[0];
          const last = list[list.length - 1];
          items.push({
            time: day,
            label: showLabel ? label : undefined,
            used: last.used,
            limit: last.limit,
            remaining: last.remaining,
            delta: last.used - first.used,
            week: weekOf(last.used, last.fetchedAt, label),
          });
        }
      }
      return items;
    }

    for (let i = filtered.length - 1; i >= 0; i--) {
      const e = filtered[i];
      const prev = view.mode === "provider"
        ? filtered.slice(0, i).reverse().find((x) => x.label === e.label)
        : filtered[i - 1];
      items.push({
        time: this.formatDateTime(new Date(e.fetchedAt)),
        label: showLabel ? e.label : undefined,
        used: e.used,
        limit: e.limit,
        remaining: e.remaining,
        delta: prev ? e.used - prev.used : undefined,
        week: weekOf(e.used, e.fetchedAt, e.label),
      });
    }
    return items;
  }

  private renderHistoryView(width: number): string[] {
    const lines: string[] = [];
    const view = this.historyView!;
    const title = view.mode === "provider"
      ? `Model Manager > Usage > History > ${view.displayName} (all windows)`
      : `Model Manager > Usage > History > ${view.displayName} · ${view.label}`;
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(title)), width));
    const subtitle = view.groupByDay
      ? "  Daily summary (newest first)"
      : "  Recent usage records (newest first)";
    lines.push(this.theme.fg("dim", subtitle));
    lines.push("");

    const items = this.collectHistoryItems(view);
    if (items.length === 0) {
      lines.push(this.theme.fg("dim", "  No history records for this view."));
    } else {
      const showLabel = view.mode === "provider";
      const labelWidth = showLabel
        ? Math.min(18, Math.max(...items.map((e) => (e.label ?? "").length), 8))
        : 0;
      const timeWidth = view.groupByDay ? 10 : 19;
      const numWidth = 9;

      const start = Math.max(0, Math.min(view.offset, Math.max(0, items.length - HISTORY_VIEW_MAX)));
      const end = Math.min(start + HISTORY_VIEW_MAX, items.length);
      const timeHeader = view.groupByDay ? "Date" : "Time";
      const headerParts: string[] = ["  ", timeHeader.padEnd(timeWidth)];
      if (showLabel) headerParts.push("Label".padEnd(labelWidth));
      headerParts.push(
        "Used".padStart(numWidth),
        "Limit".padStart(numWidth),
        "Left".padStart(numWidth),
        (view.groupByDay ? "Day Δ" : "Delta").padStart(numWidth),
        "Week Σ".padStart(numWidth),
        "Est. cost".padStart(16),
      );
      lines.push(truncateToWidth(this.theme.fg("accent", headerParts.join("")), width));

      for (let i = start; i < end; i++) {
        const item = items[i];
        const cost = item.delta !== undefined && item.delta > 0
          ? this.formatCostRange(
            estimateUsageCost(this.ctx, view.providerId, item.delta, item.label ?? view.label),
          )
          : "";
        const deltaStr = item.delta === undefined
          ? "—"
          : item.delta > 0
            ? `+${formatCompact(item.delta)}`
            : `${formatCompact(item.delta)}`;
        const weekStr = item.week === undefined ? "—" : formatCompact(item.week);
        const parts: string[] = ["  ", item.time.padEnd(timeWidth)];
        if (showLabel) parts.push((item.label ?? "").padEnd(labelWidth));
        parts.push(
          formatCompact(item.used).padStart(numWidth),
          formatCompact(item.limit).padStart(numWidth),
          formatCompact(item.remaining).padStart(numWidth),
          deltaStr.padStart(numWidth),
          weekStr.padStart(numWidth),
          cost.padStart(12),
        );
        lines.push(truncateToWidth(parts.join(""), width));
      }
      if (end < items.length || start > 0) {
        lines.push(this.theme.fg("dim", `  (${start + 1}-${end}/${items.length})`));
      }
    }

    lines.push("");
    const footer = view.groupByDay
      ? "↑↓ scroll · w window/provider · g per-record · Esc/q back"
      : "↑↓ scroll · w window/provider · g daily · Esc/q back";
    lines.push(truncateToWidth(this.theme.fg("dim", footer), width));
    return lines;
  }

  private handleHistoryInput(data: string): void {
    const kb = getKeybindings();
    const view = this.historyView!;
    if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "Q") {
      this.historyView = undefined;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "w" || data === "W") {
      view.mode = view.mode === "window" ? "provider" : "window";
      view.offset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "g" || data === "G") {
      view.groupByDay = !view.groupByDay;
      view.offset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    const itemCount = this.collectHistoryItems(view).length;
    const maxOffset = Math.max(0, itemCount - HISTORY_VIEW_MAX);
    if (kb.matches(data, "tui.select.up")) {
      view.offset = Math.max(0, view.offset - 1);
    } else if (kb.matches(data, "tui.select.down")) {
      view.offset = Math.min(maxOffset, view.offset + 1);
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private formatDateTime(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private formatDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  private renderInspect(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Model Manager > Usage > Inspect")), width));
    lines.push(this.theme.fg("dim", "  Raw provider response"));
    lines.push("");

    const inspect = this.inspect!;
    const maxVisible = 18;
    const start = Math.max(0, Math.min(inspect.offset, inspect.lines.length - maxVisible));
    const end = Math.min(start + maxVisible, inspect.lines.length);
    for (let i = start; i < end; i++) {
      lines.push(truncateToWidth(inspect.lines[i], width));
    }
    if (end < inspect.lines.length || start > 0) {
      lines.push(this.theme.fg("dim", `  (${start + 1}-${end}/${inspect.lines.length})`));
    }

    lines.push("");
    lines.push(truncateToWidth(this.theme.fg("dim", "↑↓ scroll · Esc/q back"), width));
    return lines;
  }

  private handleInspectInput(data: string): void {
    const kb = getKeybindings();
    const inspect = this.inspect!;
    if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "Q") {
      this.inspect = undefined;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      inspect.offset = Math.max(0, inspect.offset - 1);
    } else if (kb.matches(data, "tui.select.down")) {
      inspect.offset = Math.min(Math.max(0, inspect.lines.length - 1), inspect.offset + 1);
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private renderProviderHeader(row: MergedRow, width: number): string {
    const sourceTag = row.source === "snapshot" ? this.theme.fg("dim", " [cached]") : "";
    const header = `  ${this.theme.fg("accent", this.theme.bold(row.displayName))}${sourceTag}  ${this.theme.fg("dim", `(${row.providerId})`)}`;
    return truncateToWidth(header, width);
  }

  private renderRow(row: MergedRow, selected: boolean, width: number, labelWidth: number): string[] {
    const lines: string[] = [];
    const prefix = selected ? this.theme.fg("accent", "> ") : "  ";

    if (row.error) {
      lines.push(truncateToWidth(`  ${prefix}${this.theme.fg("error", row.error)}`, width));
      return lines;
    }

    const pinned = this.state.pinnedKey === `${row.providerId}::${row.label}`;
    const paddedLabel = row.label.padEnd(labelWidth);
    const label = selected ? this.theme.fg("accent", paddedLabel) : this.theme.fg("text", paddedLabel);
    // Constant-width pin slot keeps bars aligned between pinned/unpinned rows.
    const pinTag = pinned ? this.theme.fg("success", " ★") : "  ";

    const pct = row.limit > 0 ? Math.round((row.used / row.limit) * 100) : 0;
    const remainingPct = row.limit > 0 ? Math.round((row.remaining / row.limit) * 100) : 0;
    const bar = this.renderBar(row.used, row.limit, 16);
    const ratioColor = remainingPct <= 10 ? "error" : remainingPct <= 30 ? "warning" : "success";
    const status = row.limit > 0
      ? `${formatCompact(row.used)}/${formatCompact(row.limit)} · ${formatCompact(row.remaining)} left · ${pct}%`
      : `${formatCompact(row.used)} used`;
    const reset = row.resetHint ? this.theme.fg("dim", ` · ${row.resetHint}`) : "";
    lines.push(truncateToWidth(`  ${prefix}${label}${pinTag} ${bar}  ${this.theme.fg(ratioColor, status)}${reset}`, width));

    const extras = this.renderUsageExtras(row, width);
    lines.push(...extras);

    return lines;
  }

  private renderUsageExtras(row: MergedRow, width: number): string[] {
    const lines: string[] = [];
    const parts: string[] = [];

    if (row.source === "snapshot") {
      parts.push(`last check: ${this.formatAge(new Date(row.fetchedAt))}`);
    } else if (row.deltas) {
      if (row.deltas.sinceLast !== undefined && row.deltas.sinceLastAt) {
        const n = row.deltas.sinceLast;
        const marker = n > 0 ? "+" : n < 0 ? "" : "";
        const value = n < 0 ? `reset (${formatCompact(n)})` : `${marker}${formatCompact(n)}`;
        const cost = n > 0
          ? this.formatCostRange(estimateUsageCost(this.ctx, row.providerId, n, row.label))
          : "";
        parts.push(`since last: ${value}${cost ? ` · ${cost}` : ""} (${this.formatAge(new Date(row.deltas.sinceLastAt))})`);
      }
      if (row.deltas.today !== undefined) {
        const n = row.deltas.today;
        const marker = n > 0 ? "+" : n < 0 ? "" : "";
        const value = n < 0 ? `reset (${formatCompact(n)})` : `${marker}${formatCompact(n)}`;
        const cost = n > 0
          ? this.formatCostRange(estimateUsageCost(this.ctx, row.providerId, n, row.label))
          : "";
        parts.push(`today: ${value}${cost ? ` · ${cost}` : ""}`);
      }
      if (row.deltas.week !== undefined) {
        const n = row.deltas.week;
        const cost = n > 0
          ? this.formatCostRange(estimateUsageCost(this.ctx, row.providerId, n, row.label))
          : "";
        parts.push(`week: +${formatCompact(n)}${cost ? ` · ${cost}` : ""}`);
      }
    }

    if (row.label === WEEKLY_LIMIT_LABEL && row.limit > 0) {
      const barEst = estimateUsageCost(this.ctx, row.providerId, row.limit, row.label);
      if (barEst) parts.push(`bar ${this.formatCostRange(barEst)}`);
    }

    if (parts.length > 0) {
      lines.push(truncateToWidth(`      ${this.theme.fg("dim", parts.join(" · "))}`, width));
    }

    // Sparkline + burn projection on a second line when space is enough.
    const spark = buildSparkline(this.state.history, row.providerId, row.label, 16);
    const projection = computeBurnProjection(
      this.state.history,
      row.providerId,
      row.label,
      row.used,
      row.limit,
      row.fetchedAt,
    );
    const trendParts: string[] = [];
    if (spark) trendParts.push(`${this.theme.fg("accent", spark)}`);
    if (projection) trendParts.push(`burn: ${formatBurnProjection(projection)}`);
    if (trendParts.length > 0) {
      lines.push(truncateToWidth(`      ${this.theme.fg("dim", trendParts.join(" · "))}`, width));
    }

    return lines;
  }

  private formatCostRange(est: ReturnType<typeof estimateUsageCost>): string {
    if (!est) return "";
    if (est.min === est.max) return `≈${formatCost(est.avg)} list`;
    return `≈${formatCost(est.min)}–${formatCost(est.max)} list`;
  }

  private renderBar(used: number, limit: number, maxWidth: number): string {
    if (limit <= 0) return this.theme.fg("dim", "[no limit]");
    const total = Math.max(1, Math.min(maxWidth, 16));
    const filled = Math.max(0, Math.min(total, Math.round((used / limit) * total)));
    const empty = total - filled;
    const ratio = used / limit;
    const color = ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "success";
    return (
      this.theme.fg(color, "█".repeat(filled)) + this.theme.fg("dim", "░".repeat(empty))
    );
  }

  private formatAge(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  private rebuildRows(): void {
    const rows: MergedRow[] = [];
    for (const pu of this.state.usages) {
      if (pu.error) {
        rows.push({
          providerId: pu.providerId,
          displayName: pu.displayName,
          label: "error",
          used: 0,
          limit: 0,
          remaining: 0,
          fetchedAt: pu.fetchedAt,
          source: pu.source ?? "live",
          error: pu.error,
          rawResponse: pu.rawResponse,
        });
        continue;
      }
      for (const w of pu.windows) {
        rows.push({
          providerId: pu.providerId,
          displayName: pu.displayName,
          label: w.label,
          used: w.used,
          limit: w.limit,
          remaining: w.remaining,
          resetHint: w.resetHint,
          fetchedAt: pu.fetchedAt,
          source: pu.source ?? "live",
          rawResponse: pu.rawResponse,
          deltas: computeUsageDeltas(this.state.history, pu.providerId, w.label, w.used, pu.fetchedAt),
        });
      }
      if (pu.windows.length === 0) {
        rows.push({
          providerId: pu.providerId,
          displayName: pu.displayName,
          label: "no data",
          used: 0,
          limit: 0,
          remaining: 0,
          fetchedAt: pu.fetchedAt,
          source: pu.source ?? "live",
          rawResponse: pu.rawResponse,
        });
      }
    }

    if (this.state.pinnedKey) {
      const pinnedIndex = rows.findIndex((r) => `${r.providerId}::${r.label}` === this.state.pinnedKey);
      if (pinnedIndex > 0) {
        const [pinned] = rows.splice(pinnedIndex, 1);
        rows.unshift(pinned);
      }
      this.selectedIndex = 0;
    }

    this.rows = rows;
    if (this.selectedIndex >= this.rows.length) {
      this.selectedIndex = Math.max(0, this.rows.length - 1);
    }
  }
}
