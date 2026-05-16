import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  FindToolDetails,
  LsToolDetails,
  ReadToolDetails,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { isDevelopmentCommand, renderBashCall } from "./bash-display.js";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  clearCompletedToolStatusLine,
  prefixToolStatusLine,
  renderBlinkingToolCall,
  renderWrappedToolText,
  scheduleCompletedToolStatusInvalidate,
  setCompletedToolStatusLine,
  TOOL_RESULT_INDENT,
} from "./tool-status-bullets.js";
import {
  compactOutputLines,
  countNonEmptyLines,
  extractTextOutput,
  isLikelyQuietCommand,
  pluralize,
  previewLines,
  sanitizeAnsiForThemedOutput,
  shortenPath,
  splitLines,
} from "./render-utils.js";
import { renderDevToolAccent, renderToolAccent, renderToolLabel } from "./tool-label-style.js";
import { renderEditDiffResult, renderWriteDiffResult } from "./diff-renderer.js";
import {
  buildPromptSnippetFromDescription,
  extractPromptMetadata,
  getTextField,
  isMcpToolCandidate,
  MCP_PROXY_PROMPT_GUIDELINES,
  MCP_PROXY_PROMPT_SNIPPET,
  toRecord,
} from "./tool-metadata.js";
import {
  getConversationInterruptedText,
  formatConversationInterruptedLabel,
  isDefaultAbortMessage,
} from "./interruption-label.js";
import type {
  BuiltInToolOverrideName,
  ToolDisplayConfig,
} from "./types.js";
import {
  countWriteContentLines,
  getWriteContentSizeBytes,
  shouldRenderWriteCallSummary,
} from "./write-display-utils.js";

interface BuiltInTools {
  read: ReturnType<typeof createReadTool>;
  find: ReturnType<typeof createFindTool>;
  ls: ReturnType<typeof createLsTool>;
  bash: ReturnType<typeof createBashTool>;
  edit: ReturnType<typeof createEditTool>;
  write: ReturnType<typeof createWriteTool>;
}

type ConfigGetter = () => ToolDisplayConfig;

interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface RtkCompactionInfo {
  applied: boolean;
  techniques: string[];
  truncated: boolean;
  originalLineCount?: number;
  compactedLineCount?: number;
}

interface ToolRenderContextLike {
  args?: unknown;
  toolCallId?: string;
  state?: unknown;
  isError?: boolean;
  invalidate?(): void;
}

interface WriteExecutionMeta {
  previousContent?: string;
  fileExistedBeforeWrite: boolean;
}

type ToolStatusMeta<TArgs = Record<string, unknown>> = {
  tool: string;
  args: TArgs;
  durationMs: number;
};

type DetailsWithToolStatusMeta<
  TDetails,
  TArgs = Record<string, unknown>,
> = TDetails & {
  toolStatusMeta?: ToolStatusMeta<TArgs>;
};

const builtInToolCache = new Map<string, BuiltInTools>();
const RTK_COMPACTION_LABEL = "compacted by RTK";
const WRITE_EXECUTION_META_STATE_KEY = "__piToolDisplayWriteExecutionMeta";
const SHOW_PENDING_TOOL_STATUS = {
  showPendingWhenStarted: true,
  showPendingWhilePartial: true,
} as const;

function withToolStatusMeta<
  TDetails extends object,
  TArgs extends Record<string, unknown>,
>(
  details: TDetails | undefined,
  tool: string,
  args: TArgs,
  durationMs: number,
): DetailsWithToolStatusMeta<TDetails, TArgs> {
  return {
    ...(details ?? ({} as TDetails)),
    toolStatusMeta: {
      tool,
      args,
      durationMs,
    },
  };
}

function getToolStatusMeta<
  TDetails extends object,
  TArgs extends Record<string, unknown>,
>(
  details: TDetails | undefined,
): ToolStatusMeta<TArgs> | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  return (details as DetailsWithToolStatusMeta<TDetails, TArgs>).toolStatusMeta;
}

function cloneToolParameters<T>(parameters: T, seen = new WeakMap<object, unknown>()): T {
  if (parameters === null || typeof parameters !== "object") {
    return parameters;
  }

  if (seen.has(parameters)) {
    return seen.get(parameters) as T;
  }

  const clone = Array.isArray(parameters)
    ? []
    : Object.create(Object.getPrototypeOf(parameters));
  seen.set(parameters, clone);

  for (const key of Reflect.ownKeys(parameters)) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    if (!descriptor) {
      continue;
    }

    if ("value" in descriptor) {
      descriptor.value = cloneToolParameters(descriptor.value, seen);
    }

    Object.defineProperty(clone, key, descriptor);
  }

  return clone as T;
}

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = builtInToolCache.get(cwd);
  if (!tools) {
    tools = {
      read: createReadTool(cwd),
      find: createFindTool(cwd),
      ls: createLsTool(cwd),
      bash: createBashTool(cwd),
      edit: createEditTool(cwd),
      write: createWriteTool(cwd),
    };
    builtInToolCache.set(cwd, tools);
  }
  return tools;
}

function resolveWriteTargetPath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return cwd;
  }

  const expandedHome =
    trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? `${homedir()}${trimmed.slice(1)}`
      : trimmed;

  return isAbsolute(expandedHome) ? expandedHome : resolve(cwd, expandedHome);
}

function captureExistingWriteContent(
  cwd: string,
  rawPath: unknown,
): { existed: boolean; content?: string } {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { existed: false };
  }

  const resolvedPath = resolveWriteTargetPath(cwd, rawPath);
  if (!existsSync(resolvedPath)) {
    return { existed: false };
  }

  try {
    return {
      existed: true,
      content: readFileSync(resolvedPath, "utf8"),
    };
  } catch {
    return { existed: true };
  }
}

function buildPreviewText(
  lines: string[],
  maxLines: number,
  theme: RenderTheme,
  expanded: boolean,
  options: { indentBody?: boolean; wrapIndentedBody?: boolean } = {},
): string {
  const normalizedLines = [...lines];
  while (
    normalizedLines.length > 0
    && sanitizeAnsiForThemedOutput(normalizedLines[0] ?? "").trim().length === 0
  ) {
    normalizedLines.shift();
  }
  if (options.indentBody) {
    for (let index = normalizedLines.length - 1; index >= 0; index--) {
      if (sanitizeAnsiForThemedOutput(normalizedLines[index] ?? "").trim().length === 0) {
        normalizedLines.splice(index, 1);
      }
    }
  }

  if (normalizedLines.length === 0) {
    return renderToolResultLine(theme, "muted", "└ (no output)");
  }

  const { shown, remaining } = previewLines(normalizedLines, maxLines);
  const renderedLines = shown
    .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)));
  const indentedBodyPrefix = " ".repeat(visibleWidth(`${TOOL_RESULT_INDENT}└ `));
  let text = renderedLines.join("\n");
  if (options.indentBody) {
    const [firstLine = "", ...restLines] = renderedLines;
    const marker = theme.fg("muted", `${TOOL_RESULT_INDENT}└ `);
    const renderedRestLines = restLines.map((line) =>
      options.wrapIndentedBody ? line : `${indentedBodyPrefix}${line}`
    );
    text = [
      `${marker}${firstLine}`,
      ...renderedRestLines,
    ].join("\n");
  }
  if (remaining > 0) {
    const hint = expanded ? "" : " • Ctrl+O to expand";
    const remainingText = theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`);
    text += options.indentBody
      ? `\n${options.wrapIndentedBody ? remainingText : `${indentedBodyPrefix}${remainingText}`}`
      : `\n${remainingText}`;
  }
  return text;
}

function prepareOutputLines(
  rawText: string,
  options: ToolRenderResultOptions,
): string[] {
  return compactOutputLines(splitLines(rawText), {
    expanded: options.expanded,
    maxCollapsedConsecutiveEmptyLines: 1,
  });
}

function formatBashNoOutputLine(
  command: string | undefined,
  theme: RenderTheme,
): string {
  if (isLikelyQuietCommand(command)) {
    return renderToolResultLine(theme, "muted", "└ command completed (no output)");
  }
  return renderToolResultLine(theme, "muted", "└ (no output)");
}

function truncationHint(
  details: { truncation?: { truncated?: boolean } } | undefined,
): string {
  return details?.truncation?.truncated ? " • truncated" : "";
}

function countTextLines(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  return splitLines(value).length;
}

function lineRange(offset?: number, limit?: number): string | undefined {
  if (offset === undefined && limit === undefined) {
    return undefined;
  }

  const start = offset ?? 1;
  if (limit === undefined) {
    return `${start}`;
  }
  return `${start}-${start + limit - 1}`;
}

function formatLineLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}

function joinMeta(parts: Array<string | undefined | false>): string | undefined {
  const filtered = parts.filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return filtered.length > 0 ? filtered.join(" • ") : undefined;
}

function renderToolSummary(
  theme: RenderTheme,
  status: "success" | "error",
  label: string,
  subject?: string,
  meta?: string,
): string {
  let text = prefixToolStatusLine(
    renderToolLabel(theme, label),
    theme,
    status,
  );
  if (subject) {
    text += ` ${renderToolAccent(subject)}`;
  }
  if (meta) {
    text += theme.fg("muted", ` • ${meta}`);
  }
  return text;
}

function renderDiffStatSuffix(
  theme: RenderTheme,
  added: number,
  removed: number,
): string {
  return [
    theme.fg("muted", "("),
    theme.fg("toolDiffAdded", `+${added}`),
    theme.fg("muted", " "),
    theme.fg("toolDiffRemoved", `-${removed}`),
    theme.fg("muted", ")"),
  ].join("");
}

function renderEditWriteSummary(
  theme: RenderTheme,
  status: "success" | "error",
  label: string,
  subject: string | undefined,
  stats: { added: number; removed: number } | undefined,
  meta?: string,
): string {
  let text = prefixToolStatusLine(
    renderToolLabel(theme, label),
    theme,
    status,
  );
  if (subject) {
    text += ` ${renderToolAccent(subject)}`;
  }
  if (stats) {
    text += ` ${renderDiffStatSuffix(theme, stats.added, stats.removed)}`;
  }
  if (meta) {
    text += theme.fg("muted", ` • ${meta}`);
  }
  return text;
}

function renderToolResultLine(
  theme: RenderTheme,
  color: string,
  text: string,
): string {
  return theme.fg(color, `${TOOL_RESULT_INDENT}${text}`);
}

function syncCompletedToolCallLine(
  context: ToolRenderContextLike | undefined,
  line: string,
): void {
  if (!context?.state) {
    return;
  }
  if (setCompletedToolStatusLine(context.state, line)) {
    scheduleCompletedToolStatusInvalidate(context.state, context.invalidate);
  }
}

function clearCompletedToolCallLine(
  context: ToolRenderContextLike | undefined,
): void {
  if (context?.state) {
    clearCompletedToolStatusLine(context.state);
  }
}

function getStringField(value: unknown, field: string): string | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "string" ? raw : undefined;
}

function getNumericField(value: unknown, field: string): number | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function getToolPathArg(value: unknown): string | undefined {
  return getStringField(value, "file_path") ?? getStringField(value, "path");
}

function getToolContentArg(value: unknown): string | undefined {
  return getStringField(value, "content");
}

function getEditLineCount(value: unknown): number {
  const record = toRecord(value);
  const edits = Array.isArray(record.edits) ? record.edits : [];
  if (edits.length > 0) {
    return edits.reduce((total, edit) => {
      return total + countTextLines(getStringField(edit, "newText"));
    }, 0);
  }

  return countTextLines(record.newText);
}

function splitWriteStatusLines(value: string): string[] {
  const lines = value.replace(/\r/g, "").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function countChangedLines(previousLines: string[], nextLines: string[]): { added: number; removed: number } {
  const oldLength = previousLines.length;
  const newLength = nextLines.length;
  const cellCount = oldLength * newLength;
  if (cellCount > 250_000) {
    return { added: newLength, removed: oldLength };
  }

  const table: number[][] = Array.from({ length: oldLength + 1 }, () =>
    Array<number>(newLength + 1).fill(0)
  );
  for (let oldIndex = 1; oldIndex <= oldLength; oldIndex++) {
    for (let newIndex = 1; newIndex <= newLength; newIndex++) {
      if (previousLines[oldIndex - 1] === nextLines[newIndex - 1]) {
        table[oldIndex]![newIndex] = (table[oldIndex - 1]?.[newIndex - 1] ?? 0) + 1;
      } else {
        table[oldIndex]![newIndex] = Math.max(
          table[oldIndex - 1]?.[newIndex] ?? 0,
          table[oldIndex]?.[newIndex - 1] ?? 0,
        );
      }
    }
  }

  const common = table[oldLength]?.[newLength] ?? 0;
  return {
    added: newLength - common,
    removed: oldLength - common,
  };
}

function getWriteStatusDiffStats(
  content: string | undefined,
  executionMeta: WriteExecutionMeta | undefined,
): { added: number; removed: number } | undefined {
  if (typeof content !== "string") {
    return undefined;
  }

  const nextLines = splitWriteStatusLines(content);
  if (executionMeta?.fileExistedBeforeWrite && typeof executionMeta.previousContent === "string") {
    return countChangedLines(splitWriteStatusLines(executionMeta.previousContent), nextLines);
  }

  return { added: nextLines.length, removed: 0 };
}

function isToolError(
  result: unknown,
  context?: ToolRenderContextLike,
): boolean {
  return context?.isError === true || toRecord(result).isError === true;
}

function toStateCarrier(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function getWriteExecutionMeta(
  context: ToolRenderContextLike | undefined,
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): WriteExecutionMeta | undefined {
  if (!context) {
    return undefined;
  }

  const carrier = toStateCarrier(context.state);
  const existing = carrier
    ? toRecord(carrier[WRITE_EXECUTION_META_STATE_KEY])
    : undefined;
  if (existing && Object.keys(existing).length > 0) {
    return existing as WriteExecutionMeta;
  }

  if (!context.toolCallId) {
    return undefined;
  }

  const pending = pendingMetaByToolCallId.get(context.toolCallId);
  if (!pending) {
    return undefined;
  }

  if (carrier) {
    const storedMeta: WriteExecutionMeta = { ...pending };
    carrier[WRITE_EXECUTION_META_STATE_KEY] = storedMeta;
    pendingMetaByToolCallId.delete(context.toolCallId);
    return storedMeta;
  }

  return pending;
}

function formatLineCountSuffix(
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")})`);
}

function formatWriteCallSuffix(
  lineCount: number,
  sizeBytes: number,
  theme: RenderTheme,
): string {
  return theme.fg(
    "muted",
    ` (${lineCount} ${pluralize(lineCount, "line")} • ${formatSize(sizeBytes)})`,
  );
}

function formatInProgressLineCount(
  action: string,
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("warning", `${action}...`) + formatLineCountSuffix(lineCount, theme);
}

function summarizeReadSubject(args: Record<string, unknown> | undefined): string | undefined {
  const path = shortenPath(getToolPathArg(args));
  const offset = getNumericField(args, "offset");
  const limit = getNumericField(args, "limit");
  const range = lineRange(offset, limit);
  if (!path) {
    return undefined;
  }
  return range ? `${path}:${range}` : path;
}

function summarizeMcpSubject(
  toolName: string,
  toolLabel: string,
  args: Record<string, unknown> | undefined,
): string {
  if (toolName === "mcp") {
    return resolveMcpProxyCallTarget(args ?? {});
  }

  return toolLabel.startsWith("MCP ")
    ? toolLabel.slice("MCP ".length)
    : toolLabel;
}

function buildErrorPreview(
  rawOutput: string,
  maxLines: number,
  expanded: boolean,
  theme: RenderTheme,
): string {
  const lines = splitLines(rawOutput).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return "";
  }
  if (lines.length === 1 && isDefaultAbortMessage(lines[0])) {
    return formatConversationInterruptedLabel();
  }

  const { shown, remaining } = previewLines(lines, maxLines);
  let preview = shown
    .map((line) => theme.fg("error", sanitizeAnsiForThemedOutput(line)))
    .join("\n");
  if (remaining > 0) {
    const hint = expanded ? "" : " • Ctrl+O to expand";
    preview += `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
  }
  return preview;
}

function isAbortOnlyErrorOutput(rawOutput: string): boolean {
  const lines = splitLines(rawOutput).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length !== 1) {
    return false;
  }

  return isDefaultAbortMessage(lines[0]);
}

function normalizeAbortErrorLine(rawOutput: string): string | undefined {
  const firstLine = splitLines(rawOutput).find((line) => line.trim().length > 0)?.trim();
  if (!firstLine) {
    return undefined;
  }

  return isDefaultAbortMessage(firstLine)
    ? getConversationInterruptedText()
    : firstLine;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getRtkCompactionInfo(details: unknown): RtkCompactionInfo | undefined {
  const detailRecord = toRecord(details);
  const metadataRecord = toRecord(detailRecord.metadata);
  const topLevel = toRecord(detailRecord.rtkCompaction);
  const nested = toRecord(metadataRecord.rtkCompaction);

  const source =
    Object.keys(topLevel).length > 0
      ? topLevel
      : Object.keys(nested).length > 0
        ? nested
        : undefined;

  if (!source) {
    return undefined;
  }

  const techniques = toStringArray(source.techniques);
  const info: RtkCompactionInfo = {
    applied: source.applied === true,
    techniques,
    truncated: source.truncated === true,
    originalLineCount: normalizePositiveInteger(source.originalLineCount),
    compactedLineCount: normalizePositiveInteger(source.compactedLineCount),
  };

  if (
    !info.applied &&
    info.techniques.length === 0 &&
    !info.truncated &&
    info.originalLineCount === undefined &&
    info.compactedLineCount === undefined
  ) {
    return undefined;
  }

  return info;
}

function formatRtkTechniqueList(techniques: string[]): string {
  if (techniques.length === 0) {
    return "";
  }

  const visible = techniques.slice(0, 3).join(", ");
  const hidden = techniques.length - 3;
  return hidden > 0 ? `${visible}, +${hidden} more` : visible;
}

function formatRtkSummarySuffix(
  details: unknown,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): string {
  if (!config.showRtkCompactionHints) {
    return "";
  }

  const info = getRtkCompactionInfo(details);
  if (!info?.applied) {
    return "";
  }

  const segments: string[] = [RTK_COMPACTION_LABEL];

  const techniqueText = formatRtkTechniqueList(info.techniques);
  if (techniqueText) {
    segments.push(techniqueText);
  }
  if (info.truncated) {
    segments.push("RTK removed content");
  }

  if (segments.length === 0) {
    return "";
  }

  return theme.fg("warning", ` • ${segments.join(" • ")}`);
}

function getExpandedPreviewLineLimit(
  lines: string[],
  config: ToolDisplayConfig,
): number {
  const limit = Math.max(0, config.expandedPreviewMaxLines);
  if (limit === 0) {
    return lines.length;
  }
  return Math.min(lines.length, limit);
}

function formatExpandedPreviewCapHint(
  lines: string[],
  config: ToolDisplayConfig,
  theme: RenderTheme,
): string {
  const cap = Math.max(0, config.expandedPreviewMaxLines);
  if (cap === 0 || lines.length <= cap) {
    return "";
  }

  return `\n${theme.fg("warning", `(display capped at ${cap} lines by tool-view setting)`)}`;
}

function formatRtkPreviewHint(
  details: unknown,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): string {
  if (!config.showRtkCompactionHints) {
    return "";
  }

  const info = getRtkCompactionInfo(details);
  if (!info?.applied) {
    return "";
  }

  const hints: string[] = [];
  const techniqueText = formatRtkTechniqueList(info.techniques);
  if (techniqueText) {
    hints.push(`${RTK_COMPACTION_LABEL}: ${techniqueText}`);
  } else {
    hints.push(`${RTK_COMPACTION_LABEL} applied`);
  }

  if (
    info.originalLineCount !== undefined &&
    info.compactedLineCount !== undefined &&
    info.originalLineCount > info.compactedLineCount
  ) {
    hints.push(`${info.compactedLineCount}/${info.originalLineCount} lines kept`);
  }

  if (info.truncated) {
    hints.push("RTK removed content");
  }

  return hints.length > 0
    ? `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`
    : "";
}

function formatReadSummary(
  lines: string[],
  details: ReadToolDetails | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  let summary = renderToolResultLine(
    theme,
    "muted",
    `└ loaded ${lineCount} ${pluralize(lineCount, "line")}`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatSearchSummary(
  lines: string[],
  unitLabel: string,
  details: { truncation?: { truncated?: boolean } } | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
  pluralLabel?: string,
): string {
  const count = countNonEmptyLines(lines);
  let summary = renderToolResultLine(
    theme,
    "muted",
    `└ ${count} ${pluralize(count, unitLabel, pluralLabel)} returned`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatBashSummary(
  lines: string[],
  _details: BashToolDetails | undefined,
  theme: RenderTheme,
  _showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  return renderToolResultLine(
    theme,
    "muted",
    `└ ${lineCount} ${pluralize(lineCount, "line")} returned`,
  );
}

function formatBashTruncationHints(
  details: BashToolDetails | undefined,
  theme: RenderTheme,
): string {
  if (!details) {
    return "";
  }

  const hints: string[] = [];
  if (details.truncation?.truncated) {
    hints.push("output truncated");
  }
  if (details.fullOutputPath) {
    hints.push(`full output: ${details.fullOutputPath}`);
  }
  if (hints.length === 0) {
    return "";
  }
  return `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
}

function buildReadStatusHeader(
  result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
  details: ReadToolDetails | undefined,
  theme: RenderTheme,
  isError: boolean,
): string {
  const meta = getToolStatusMeta<ReadToolDetails, Record<string, unknown>>(details);
  const subject = summarizeReadSubject(meta?.args);
  const first = result.content[0];

  return renderToolSummary(
    theme,
    isError ? "error" : "success",
    "read",
    subject,
    joinMeta([
      first?.type === "image" ? "image" : undefined,
      isError ? "failed" : undefined,
    ]),
  );
}

function buildSearchStatusHeader(
  toolName: "find" | "ls",
  details:
    | GrepToolDetails
    | FindToolDetails
    | LsToolDetails
    | undefined,
  theme: RenderTheme,
  options?: { pluralLabel?: string; limitReached?: boolean; isError?: boolean },
): string {
  const meta = getToolStatusMeta<
    FindToolDetails | LsToolDetails,
    Record<string, unknown>
  >(details);
  const subject =
    toolName === "ls"
      ? shortenPath(getStringField(meta?.args, "path") || ".")
      : String(getStringField(meta?.args, "pattern") ?? "");

  return renderToolSummary(
    theme,
    options?.isError === true ? "error" : "success",
    toolName,
    subject,
    joinMeta([
      options?.limitReached ? "limit reached" : undefined,
      options?.isError === true ? "failed" : undefined,
    ]),
  );
}

function buildBashStatusHeader(
  details: BashToolDetails | undefined,
  result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
  theme: RenderTheme,
  isError: boolean,
): string {
  const meta = getToolStatusMeta<BashToolDetails, Record<string, unknown>>(details);
  const rawOutput = extractTextOutput(result);
  const exitMatch = rawOutput.match(/exit code:\s*(-?\d+)/i);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1] ?? "0", 10) : undefined;
  const command = getStringField(meta?.args, "command") ?? "...";
  const subject = isDevelopmentCommand(command)
    ? renderDevToolAccent(command)
    : renderToolAccent(command);

  let text = prefixToolStatusLine(
    renderToolLabel(theme, "Ran"),
    theme,
    isError ? "error" : "success",
  );
  text += ` ${subject}`;
  const metaText = joinMeta([
    exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}` : undefined,
    isError && exitCode === undefined ? "failed" : undefined,
  ]);
  if (metaText) {
    text += theme.fg("muted", ` • ${metaText}`);
  }
  return text;
}

function buildEditStatusHeader(
  details: EditToolDetails | undefined,
  rawOutput: string,
  theme: RenderTheme,
  isError: boolean,
): string {
  const meta = getToolStatusMeta<EditToolDetails, Record<string, unknown>>(details);
  const diff = typeof details?.diff === "string" ? details.diff : "";
  const diffLines = splitLines(diff);
  const added = diffLines.filter(
    (line) => line.startsWith("+") && !line.startsWith("+++"),
  ).length;
  const removed = diffLines.filter(
    (line) => line.startsWith("-") && !line.startsWith("---"),
  ).length;

  return renderEditWriteSummary(
    theme,
    isError ? "error" : "success",
    "edit",
    shortenPath(getToolPathArg(meta?.args)),
    !isError && diff ? { added, removed } : undefined,
    joinMeta([
      isError
        ? normalizeAbortErrorLine(rawOutput) ?? "failed"
        : undefined,
    ]),
  );
}

function buildWriteStatusHeader(
  details: Record<string, unknown> | undefined,
  content: string | undefined,
  rawOutput: string,
  theme: RenderTheme,
  isError: boolean,
  executionMeta?: WriteExecutionMeta,
): string {
  const meta = getToolStatusMeta<Record<string, unknown>, Record<string, unknown>>(details);

  return renderEditWriteSummary(
    theme,
    isError ? "error" : "success",
    "write",
    shortenPath(getToolPathArg(meta?.args)),
    !isError ? getWriteStatusDiffStats(content, executionMeta) : undefined,
    joinMeta([
      isError
        ? normalizeAbortErrorLine(rawOutput) ?? "failed"
        : undefined,
    ]),
  );
}

function buildMcpStatusHeader(
  toolName: string,
  toolLabel: string,
  details: unknown,
  result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
  theme: RenderTheme,
  isError: boolean,
): string {
  const meta = getToolStatusMeta<object, Record<string, unknown>>(
    details as object | undefined,
  );

  return renderToolSummary(
    theme,
    isError ? "error" : "success",
    "MCP",
    summarizeMcpSubject(toolName, toolLabel, meta?.args),
    joinMeta([
      isError ? "failed" : undefined,
    ]),
  );
}

function getBashPreviewLineLimit(
  lines: string[],
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
): number {
  if (options.expanded) {
    return getExpandedPreviewLineLimit(lines, config);
  }

  return config.bashOutputMode === "opencode"
    ? config.bashCollapsedLines
    : config.previewLines;
}

function renderBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
  indentBody: boolean,
): ReturnType<typeof renderWrappedToolText> | Text {
  const lines = prepareOutputLines(rawOutput, options);
  if (lines.length === 0) {
    return new Text("", 0, 0);
  }

  const maxLines = getBashPreviewLineLimit(lines, options, config);
  if (!options.expanded && maxLines === 0) {
    return new Text("", 0, 0);
  }

  let preview = buildPreviewText(lines, maxLines, theme, options.expanded, {
    indentBody,
    wrapIndentedBody: indentBody,
  });
  if (config.showTruncationHints) {
    preview += formatBashTruncationHints(details, theme);
  }
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }
  if (indentBody) {
    return renderWrappedToolText(preview, {
      hangingIndent: " ".repeat(visibleWidth(`${TOOL_RESULT_INDENT}└ `)),
    });
  }
  return new Text(preview, 0, 0);
}

function renderBashErrorResult(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): ReturnType<typeof renderWrappedToolText> | Text {
  const lines = prepareOutputLines(rawOutput, options);
  let text = renderToolResultLine(theme, "error", "└ command failed");

  if (lines.length > 0) {
    const maxLines = getBashPreviewLineLimit(lines, options, config);
    if (options.expanded || maxLines > 0) {
      const { shown, remaining } = previewLines(lines, maxLines);
      text += `\n${shown
        .map((line) => theme.fg("error", sanitizeAnsiForThemedOutput(line)))
        .join("\n")}`;
      if (remaining > 0) {
        const hint = options.expanded ? "" : " • Ctrl+O to expand";
        text += `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
      }
    }
  }

  if (config.showTruncationHints) {
    text += formatBashTruncationHints(details, theme);
  }
  if (options.expanded && lines.length > 0) {
    text += formatExpandedPreviewCapHint(lines, config, theme);
  }

  return renderWrappedToolText(text, {
    hangingIndent: " ".repeat(visibleWidth(`${TOOL_RESULT_INDENT}└ `)),
  });
}

function renderSearchResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
    isError?: boolean;
  },
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  unitLabel: string,
  details: FindToolDetails | LsToolDetails | undefined,
  pluralLabel?: string,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "running..."), 0, 0);
  }

  const rawOutput = extractTextOutput(result);
  const lines = prepareOutputLines(rawOutput, options);

  if (result.isError === true) {
    if (config.searchOutputMode === "hidden") {
      return new Text("", 0, 0);
    }

    const body = buildErrorPreview(
      rawOutput,
      options.expanded ? getExpandedPreviewLineLimit(lines, config) : config.previewLines,
      options.expanded,
      theme,
    );
    return new Text(body, 0, 0);
  }

  if (config.searchOutputMode === "hidden") {
    return new Text("", 0, 0);
  }

  if (config.searchOutputMode === "count") {
    let summary = formatSearchSummary(
      lines,
      unitLabel,
      details,
      theme,
      config.showTruncationHints,
      pluralLabel,
    );
    summary += formatRtkSummarySuffix(details, config, theme);
    return new Text(summary, 0, 0);
  }

  const maxLines = options.expanded
    ? getExpandedPreviewLineLimit(lines, config)
    : config.previewLines;
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (config.showTruncationHints && details?.truncation?.truncated) {
    preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
  }
  preview += formatRtkPreviewHint(details, config, theme);
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }
  return new Text(preview, 0, 0);
}

function resolveMcpProxyCallTarget(args: Record<string, unknown>): string {
  const tool = getTextField(args, "tool");
  const connect = getTextField(args, "connect");
  const describe = getTextField(args, "describe");
  const search = getTextField(args, "search");
  const server = getTextField(args, "server");

  if (tool) {
    return server ? `call ${server}:${tool}` : `call ${tool}`;
  }
  if (connect) {
    return `connect ${connect}`;
  }
  if (describe) {
    return server ? `describe ${describe} @${server}` : `describe ${describe}`;
  }
  if (search) {
    return server ? `search "${search}" @${server}` : `search "${search}"`;
  }
  if (server) {
    return `tools ${server}`;
  }
  return "status";
}

function formatMcpCallLine(
  toolName: string,
  toolLabel: string,
  args: Record<string, unknown>,
  theme: RenderTheme,
): string {
  const argCount = Object.keys(args).length;
  const argSuffix =
    argCount === 0
      ? theme.fg("muted", " (no args)")
      : theme.fg("muted", ` (${argCount} ${pluralize(argCount, "arg")})`);
  const target =
    toolName === "mcp"
      ? resolveMcpProxyCallTarget(args)
      : toolLabel.startsWith("MCP ")
        ? toolLabel.slice("MCP ".length)
        : toolLabel;

  return `${renderToolLabel(theme, "MCP")} ${renderToolAccent(target)}${argSuffix}`;
}

function getMcpTruncationDetails(details: unknown): {
  truncated: boolean;
  fullOutputPath?: string;
} {
  const detailRecord = toRecord(details);
  const truncation = toRecord(detailRecord.truncation);

  const fullOutputPath =
    typeof truncation.fullOutputPath === "string"
      ? truncation.fullOutputPath
      : typeof detailRecord.fullOutputPath === "string"
        ? detailRecord.fullOutputPath
        : undefined;

  return {
    truncated: truncation.truncated === true,
    fullOutputPath,
  };
}

function renderMcpResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
    isError?: boolean;
  },
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "running..."), 0, 0);
  }

  if (config.mcpOutputMode === "hidden") {
    return new Text("", 0, 0);
  }

  const rawOutput = extractTextOutput(result);
  const lines = prepareOutputLines(rawOutput, options);
  const truncation = getMcpTruncationDetails(result.details);

  if (result.isError === true) {
    const body = buildErrorPreview(
      rawOutput,
      options.expanded ? getExpandedPreviewLineLimit(lines, config) : config.previewLines,
      options.expanded,
      theme,
    );
    return new Text(body, 0, 0);
  }

  if (config.mcpOutputMode === "summary") {
    const lineCount = countNonEmptyLines(lines);
    let summary = renderToolResultLine(
      theme,
      "muted",
      `└ ${lineCount} ${pluralize(lineCount, "line")} returned`,
    );
    if (config.showTruncationHints && truncation.truncated) {
      summary += theme.fg("warning", " • truncated");
    }
    summary += formatRtkSummarySuffix(result.details, config, theme);
    return new Text(summary, 0, 0);
  }

  const maxLines = options.expanded
    ? getExpandedPreviewLineLimit(lines, config)
    : config.previewLines;
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (
    config.showTruncationHints &&
    (truncation.truncated || truncation.fullOutputPath)
  ) {
    const hints: string[] = [];
    if (truncation.truncated) {
      hints.push("truncated by backend limits");
    }
    if (truncation.fullOutputPath) {
      hints.push(`full output: ${truncation.fullOutputPath}`);
    }
    preview += `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
  }

  preview += formatRtkPreviewHint(result.details, config, theme);
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }

  return new Text(preview, 0, 0);
}

export function registerToolDisplayOverrides(
  pi: ExtensionAPI,
  getConfig: ConfigGetter,
): void {
  const bootstrapTools = getBuiltInTools(process.cwd());
  const builtInPromptMetadata = {
    read: extractPromptMetadata(bootstrapTools.read),
    find: extractPromptMetadata(bootstrapTools.find),
    ls: extractPromptMetadata(bootstrapTools.ls),
    bash: extractPromptMetadata(bootstrapTools.bash),
    edit: extractPromptMetadata(bootstrapTools.edit),
    write: extractPromptMetadata(bootstrapTools.write),
  };
  const clonedParameters = {
    read: cloneToolParameters(bootstrapTools.read.parameters),
    find: cloneToolParameters(bootstrapTools.find.parameters),
    ls: cloneToolParameters(bootstrapTools.ls.parameters),
    bash: cloneToolParameters(bootstrapTools.bash.parameters),
    edit: cloneToolParameters(bootstrapTools.edit.parameters),
    write: cloneToolParameters(bootstrapTools.write.parameters),
  };
  const writeExecutionMetaByToolCallId = new Map<string, WriteExecutionMeta>();

  const registerIfOwned = (
    toolName: BuiltInToolOverrideName,
    register: () => void,
  ): void => {
    if (getConfig().registerToolOverrides[toolName]) {
      register();
    }
  };

  registerIfOwned("read", () => {
    pi.registerTool({
      name: "read",
      label: "read",
      description: bootstrapTools.read.description,
      ...builtInPromptMetadata.read,
      renderShell: "self",
      parameters: clonedParameters.read,
      prepareArguments: bootstrapTools.read.prepareArguments,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const started = Date.now();
        const result = await getBuiltInTools(ctx.cwd).read.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
        );
        return {
          ...result,
          details: withToolStatusMeta(
            result.details as ReadToolDetails | undefined,
            "read",
            params as Record<string, unknown>,
            Date.now() - started,
          ),
        };
      },
      renderCall(args, theme, context) {
        return renderBlinkingToolCall(() => {
          const path = shortenPath(getToolPathArg(args));
          const offset = getNumericField(args, "offset");
          const limit = getNumericField(args, "limit");
          let suffix = "";
          if (offset !== undefined || limit !== undefined) {
            const from = offset ?? 1;
            const to =
              limit !== undefined ? from + limit - 1 : undefined;
            suffix = to ? `:${from}-${to}` : `:${from}`;
          }
          return `${renderToolLabel(theme, "read")} ${renderToolAccent(`${path || "..."}${suffix}`)}`;
        }, theme, context, SHOW_PENDING_TOOL_STATUS);
      },
      renderResult(result, options, theme, context) {
        if (options.isPartial) {
          clearCompletedToolCallLine(context);
          return new Text(theme.fg("warning", "reading..."), 0, 0);
        }

        const config = getConfig();
        const details = result.details as ReadToolDetails | undefined;
        const header = buildReadStatusHeader(result, details, theme, isToolError(result, context));
        syncCompletedToolCallLine(context, header);
        const rawOutput = extractTextOutput(result);
        const lines = prepareOutputLines(rawOutput, options);

        if (result.isError === true) {
          if (config.readOutputMode === "hidden") {
            return new Text("", 0, 0);
          }

          const body = buildErrorPreview(
            rawOutput,
            options.expanded ? getExpandedPreviewLineLimit(lines, config) : config.previewLines,
            options.expanded,
            theme,
          );
          return new Text(body, 0, 0);
        }

        if (config.readOutputMode === "hidden") {
          return new Text("", 0, 0);
        }

        if (config.readOutputMode === "summary") {
          const summaryLines = compactOutputLines(splitLines(rawOutput), {
            expanded: true,
          });
          let summary = formatReadSummary(
            summaryLines,
            details,
            theme,
            config.showTruncationHints,
          );
          summary += formatRtkSummarySuffix(result.details, config, theme);
          return new Text(summary, 0, 0);
        }

        const maxLines = options.expanded
          ? getExpandedPreviewLineLimit(lines, config)
          : config.previewLines;
        let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
        if (config.showTruncationHints && details?.truncation?.truncated) {
          preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
        }
        preview += formatRtkPreviewHint(result.details, config, theme);
        if (options.expanded) {
          preview += formatExpandedPreviewCapHint(lines, config, theme);
        }
        return new Text(preview, 0, 0);
      },
    });
  });

  registerIfOwned("find", () => {
    pi.registerTool({
      name: "find",
    label: "find",
    description: bootstrapTools.find.description,
    ...builtInPromptMetadata.find,
    renderShell: "self",
    parameters: clonedParameters.find,
    prepareArguments: bootstrapTools.find.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const started = Date.now();
      const result = await getBuiltInTools(ctx.cwd).find.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
      return {
        ...result,
        details: withToolStatusMeta(
          result.details as FindToolDetails | undefined,
          "find",
          params as Record<string, unknown>,
          Date.now() - started,
        ),
      };
    },
    renderCall(args, theme, context) {
      return renderBlinkingToolCall(() => {
        const scope = shortenPath(args.path || ".");
        const limitSuffix =
          args.limit !== undefined ? ` (limit ${args.limit})` : "";
        return `${renderToolLabel(theme, "find")} ${renderToolAccent(args.pattern)}${theme.fg("muted", ` in ${scope}${limitSuffix}`)}`;
      }, theme, context, SHOW_PENDING_TOOL_STATUS);
    },
    renderResult(result, options, theme, context) {
      const config = getConfig();
      const details = result.details as FindToolDetails | undefined;
      const header = buildSearchStatusHeader(
        "find",
        details,
        theme,
        {
          limitReached: details?.resultLimitReached,
          isError: isToolError(result, context),
        },
      );
      if (options.isPartial) {
        clearCompletedToolCallLine(context);
      } else {
        syncCompletedToolCallLine(context, header);
      }
      return renderSearchResult(
        result,
        options,
        config,
        theme,
        "result",
        details,
      );
    },
    });
  });

  registerIfOwned("ls", () => {
    pi.registerTool({
      name: "ls",
    label: "ls",
    description: bootstrapTools.ls.description,
    ...builtInPromptMetadata.ls,
    renderShell: "self",
    parameters: clonedParameters.ls,
    prepareArguments: bootstrapTools.ls.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const started = Date.now();
      const result = await getBuiltInTools(ctx.cwd).ls.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
      return {
        ...result,
        details: withToolStatusMeta(
          result.details as LsToolDetails | undefined,
          "ls",
          params as Record<string, unknown>,
          Date.now() - started,
        ),
      };
    },
    renderCall(args, theme, context) {
      return renderBlinkingToolCall(() => {
        const scope = shortenPath(args.path || ".");
        const limitSuffix =
          args.limit !== undefined ? ` (limit ${args.limit})` : "";
        return `${renderToolLabel(theme, "ls")} ${renderToolAccent(scope)}${theme.fg("muted", limitSuffix)}`;
      }, theme, context, SHOW_PENDING_TOOL_STATUS);
    },
    renderResult(result, options, theme, context) {
      const config = getConfig();
      const details = result.details as LsToolDetails | undefined;
      const header = buildSearchStatusHeader(
        "ls",
        details,
        theme,
        {
          limitReached: details?.entryLimitReached,
          pluralLabel: "entries",
          isError: isToolError(result, context),
        },
      );
      if (options.isPartial) {
        clearCompletedToolCallLine(context);
      } else {
        syncCompletedToolCallLine(context, header);
      }
      return renderSearchResult(
        result,
        options,
        config,
        theme,
        "entry",
        details,
        "entries",
      );
    },
    });
  });

  registerIfOwned("edit", () => {
    pi.registerTool({
      name: "edit",
    label: "edit",
    description: bootstrapTools.edit.description,
    ...builtInPromptMetadata.edit,
    renderShell: "self",
    parameters: clonedParameters.edit,
    prepareArguments: bootstrapTools.edit.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const started = Date.now();
      const result = await getBuiltInTools(ctx.cwd).edit.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
      return {
        ...result,
        details: withToolStatusMeta(
          result.details as EditToolDetails | undefined,
          "edit",
          params as Record<string, unknown>,
          Date.now() - started,
        ),
      };
    },
    renderCall(args, theme, context) {
      return renderBlinkingToolCall(() => {
        const path = shortenPath(getToolPathArg(args));
        const lineCount = getEditLineCount(args);
        return `${renderToolLabel(theme, "edit")} ${renderToolAccent(path || "...")}${formatLineCountSuffix(lineCount, theme)}`;
      }, theme, context, SHOW_PENDING_TOOL_STATUS);
    },
    renderResult(result, options, theme, context) {
      const lineCount = getEditLineCount(context?.args);
      if (options.isPartial) {
        clearCompletedToolCallLine(context);
        return new Text(
          formatInProgressLineCount("editing", lineCount, theme),
          0,
          0,
        );
      }

      const fallbackText = extractTextOutput(result);
      if (isToolError(result, context)) {
        const header = buildEditStatusHeader(
          result.details as EditToolDetails | undefined,
          fallbackText,
          theme,
          true,
        );
        syncCompletedToolCallLine(context, header);
        const body = !isAbortOnlyErrorOutput(fallbackText) && fallbackText
          ? buildErrorPreview(
            fallbackText,
            getConfig().previewLines,
            options.expanded,
            theme,
          )
          : "";
        return new Text(body, 0, 0);
      }

      const config = getConfig();
      const details = result.details as EditToolDetails | undefined;
      const header = buildEditStatusHeader(details, fallbackText, theme, false);
      syncCompletedToolCallLine(context, header);
      return renderEditDiffResult(
        details,
        { expanded: options.expanded, filePath: getToolPathArg(context?.args) },
        config,
        theme,
        fallbackText,
      );
    },
    });
  });

  registerIfOwned("write", () => {
    pi.registerTool({
      name: "write",
    label: "write",
    description: bootstrapTools.write.description,
    ...builtInPromptMetadata.write,
    renderShell: "self",
    parameters: clonedParameters.write,
    prepareArguments: bootstrapTools.write.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const started = Date.now();
      const previous = captureExistingWriteContent(ctx.cwd, params.path);
      writeExecutionMetaByToolCallId.set(toolCallId, {
        fileExistedBeforeWrite: previous.existed,
        previousContent: previous.content,
      });

      const result = await getBuiltInTools(ctx.cwd).write.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
      return {
        ...result,
        details: withToolStatusMeta(
          result.details as Record<string, unknown> | undefined,
          "write",
          params as Record<string, unknown>,
          Date.now() - started,
        ),
      };
    },
    renderCall(args, theme, context) {
      return renderBlinkingToolCall(() => {
        const content = getToolContentArg(args);
        const lineCount = countWriteContentLines(content);
        const sizeBytes = getWriteContentSizeBytes(content);
        const path = shortenPath(getToolPathArg(args));
        const suffix = shouldRenderWriteCallSummary({
          hasContent: content !== undefined,
          hasDetailedResultHeader: false,
        })
          ? formatWriteCallSuffix(lineCount, sizeBytes, theme)
          : "";
        return `${renderToolLabel(theme, "write")} ${renderToolAccent(path || "...")}${suffix}`;
      }, theme, context, SHOW_PENDING_TOOL_STATUS);
    },
    renderResult(result, options, theme, context) {
      const content = getToolContentArg(context?.args);
      const lineCount = countWriteContentLines(content);
      if (options.isPartial) {
        clearCompletedToolCallLine(context);
        return new Text(
          formatInProgressLineCount("writing", lineCount, theme),
          0,
          0,
        );
      }

      const fallbackText = extractTextOutput(result);
      if (isToolError(result, context)) {
        const header = buildWriteStatusHeader(
          result.details as Record<string, unknown> | undefined,
          content,
          fallbackText,
          theme,
          true,
        );
        syncCompletedToolCallLine(context, header);
        const body = !isAbortOnlyErrorOutput(fallbackText) && fallbackText
          ? buildErrorPreview(
            fallbackText,
            getConfig().previewLines,
            options.expanded,
            theme,
          )
          : "";
        return new Text(body, 0, 0);
      }

      const config = getConfig();
      const executionMeta = getWriteExecutionMeta(
        context,
        writeExecutionMetaByToolCallId,
      );
      const header = buildWriteStatusHeader(
        result.details as Record<string, unknown> | undefined,
        content,
        fallbackText,
        theme,
        false,
        executionMeta,
      );
      syncCompletedToolCallLine(context, header);
      return renderWriteDiffResult(
        content,
        {
          expanded: options.expanded,
          filePath: getToolPathArg(context?.args),
          previousContent: executionMeta?.previousContent,
          fileExistedBeforeWrite: executionMeta?.fileExistedBeforeWrite ?? false,
        },
        config,
        theme,
        fallbackText,
      );
    },
    });
  });

  registerIfOwned("bash", () => {
    pi.registerTool({
      name: "bash",
    label: "bash",
    description: bootstrapTools.bash.description,
    ...builtInPromptMetadata.bash,
    renderShell: "self",
    parameters: clonedParameters.bash,
    prepareArguments: bootstrapTools.bash.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const started = Date.now();
      const result = await getBuiltInTools(ctx.cwd).bash.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
      return {
        ...result,
        details: withToolStatusMeta(
          result.details as BashToolDetails | undefined,
          "bash",
          params as Record<string, unknown>,
          Date.now() - started,
        ),
      };
    },
    renderCall(args, theme, context) {
      return renderBashCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      const config = getConfig();
      const details = result.details as BashToolDetails | undefined;
      const rawOutput = extractTextOutput(result);
      const failed = isToolError(result, context);
      const header = buildBashStatusHeader(details, result, theme, failed);

      if (options.isPartial) {
        clearCompletedToolCallLine(context);
        return renderBashLivePreview(rawOutput, options, config, theme, details, true);
      }

      syncCompletedToolCallLine(context, header);

      if (failed) {
        return renderBashErrorResult(rawOutput, options, config, theme, details);
      }

      const lines = prepareOutputLines(rawOutput, options);

      if (lines.length === 0) {
        let text = formatBashNoOutputLine(getStringField(context?.args, "command"), theme);
        if (config.showTruncationHints) {
          text += formatBashTruncationHints(details, theme);
        }
        return new Text(text, 0, 0);
      }

      if (config.bashOutputMode === "summary") {
        let summary = formatBashSummary(
          lines,
          details,
          theme,
          config.showTruncationHints,
        );
        if (config.showTruncationHints) {
          summary += formatBashTruncationHints(details, theme);
        }
        return new Text(summary, 0, 0);
      }

      if (config.bashOutputMode === "preview") {
        const maxLines = options.expanded
          ? getExpandedPreviewLineLimit(lines, config)
          : config.previewLines;
        let preview = buildPreviewText(lines, maxLines, theme, options.expanded, {
          indentBody: true,
          wrapIndentedBody: true,
        });
        if (config.showTruncationHints) {
          preview += formatBashTruncationHints(details, theme);
        }
        if (options.expanded) {
          preview += formatExpandedPreviewCapHint(lines, config, theme);
        }
        return renderWrappedToolText(preview, {
          hangingIndent: " ".repeat(visibleWidth(`${TOOL_RESULT_INDENT}└ `)),
        });
      }

      if (!options.expanded && config.bashCollapsedLines === 0) {
        let hidden = renderToolResultLine(theme, "muted", "└ output hidden");
        if (config.showTruncationHints) {
          hidden += formatBashTruncationHints(details, theme);
        }
        return new Text(hidden, 0, 0);
      }

      const maxLines = options.expanded
        ? lines.length
        : config.bashCollapsedLines;
      let text = buildPreviewText(lines, maxLines, theme, options.expanded, {
        indentBody: true,
        wrapIndentedBody: true,
      });
      if (config.showTruncationHints) {
        text += formatBashTruncationHints(details, theme);
      }
      return renderWrappedToolText(text, {
        hangingIndent: " ".repeat(visibleWidth(`${TOOL_RESULT_INDENT}└ `)),
      });
    },
    });
  });

  const wrappedMcpToolNames = new Set<string>();

  const registerMcpToolOverrides = (): void => {
    let allTools: unknown[] = [];
    try {
      allTools = pi.getAllTools();
    } catch {
      return;
    }

    for (const candidate of allTools) {
      if (!isMcpToolCandidate(candidate)) {
        continue;
      }

      const toolName = getTextField(candidate, "name");
      if (!toolName || wrappedMcpToolNames.has(toolName)) {
        continue;
      }

      const toolRecord = toRecord(candidate);
      const executeCandidate = toolRecord.execute;
      if (typeof executeCandidate !== "function") {
        continue;
      }

      const executeDelegate = executeCandidate as (...args: unknown[]) => unknown;
      const prepareArgumentsDelegate =
        typeof toolRecord.prepareArguments === "function"
          ? (toolRecord.prepareArguments as (args: unknown) => unknown)
          : undefined;
      const toolLabel =
        getTextField(candidate, "label") ||
        (toolName === "mcp" ? "MCP Proxy" : `MCP ${toolName}`);
      const toolDescription =
        getTextField(candidate, "description") || "MCP tool";
      const parameters = toRecord(toolRecord.parameters);

      const promptMetadata =
        toolName === "mcp"
          ? {
              promptSnippet: MCP_PROXY_PROMPT_SNIPPET,
              promptGuidelines: [...MCP_PROXY_PROMPT_GUIDELINES],
            }
          : {
              promptSnippet: buildPromptSnippetFromDescription(
                toolDescription,
                `Call MCP tool '${toolName}'.`,
              ),
            };

      pi.registerTool({
        name: toolName,
        label: toolLabel,
        description: toolDescription,
        ...promptMetadata,
        renderShell: "self",
        parameters,
        prepareArguments: prepareArgumentsDelegate,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const started = Date.now();
          const result = await Promise.resolve(
            executeDelegate(toolCallId, params, signal, onUpdate, ctx),
          );
          return {
            ...toRecord(result),
            details: withToolStatusMeta(
              toRecord(result).details as Record<string, unknown> | undefined,
              toolName,
              params as Record<string, unknown>,
              Date.now() - started,
            ),
          };
        },
        renderCall(args, theme, context) {
          return renderBlinkingToolCall(
            () => formatMcpCallLine(toolName, toolLabel, toRecord(args), theme),
            theme,
            context,
            SHOW_PENDING_TOOL_STATUS,
          );
        },
        renderResult(result, options, theme, context) {
          const header = buildMcpStatusHeader(
            toolName,
            toolLabel,
            result.details,
            result,
            theme,
            isToolError(result, context),
          );
          if (options.isPartial) {
            clearCompletedToolCallLine(context);
          } else {
            syncCompletedToolCallLine(context, header);
          }
          return renderMcpResult(result, options, getConfig(), theme);
        },
      });

      wrappedMcpToolNames.add(toolName);
    }
  };

  pi.on("session_start", async () => {
    registerMcpToolOverrides();
  });
  pi.on("before_agent_start", async () => {
    registerMcpToolOverrides();
  });
}
