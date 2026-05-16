import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

const TOOL_STATUS_BULLET_STATE_KEY = "__piToolDisplayStatusBullet";
const TOOL_STATUS_BULLET_INTERVAL_MS = 700;
export const TOOL_HISTORY_INDENT = " ";
export const TOOL_RESULT_INDENT = `${TOOL_HISTORY_INDENT}  `;

export type ToolStatusBulletState = "pending" | "success" | "error";

export interface ToolStatusBulletTheme {
  fg(color: string, text: string): string;
}

export interface ToolStatusBulletCallContextLike {
  executionStarted: boolean;
  isPartial: boolean;
  invalidate(): void;
  lastComponent?: unknown;
  state?: unknown;
}

interface ToolStatusBulletAnimationState {
  visible: boolean;
  completedLine?: string;
  completedLineInvalidateScheduled?: boolean;
  timer?: ReturnType<typeof setInterval>;
}

type WrappedToolCallFrame =
  | {
      kind: "prefixed";
      content: string;
      initialPrefix: string;
      subsequentPrefix: string;
      singleLine?: boolean;
    }
  | {
      kind: "raw";
      text: string;
      hangingIndent?: string;
      singleLine?: boolean;
    };

class WrappedToolCallText {
  private frame: WrappedToolCallFrame = { kind: "raw", text: "" };
  private cachedWidth?: number;
  private cachedLines?: string[];

  setFrame(frame: WrappedToolCallFrame): void {
    this.frame = frame;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = this.frame.singleLine
      ? renderSingleLineFrame(this.frame, width)
      : this.frame.kind === "prefixed"
        ? renderPrefixedFrame(this.frame, width)
        : renderRawFrame(this.frame.text, width, this.frame.hangingIndent);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function padLineToWidth(line: string, width: number): string {
  const safeWidth = Math.max(0, width);
  let fitted = line;
  if (visibleWidth(fitted) > safeWidth) {
    fitted = truncateToWidth(fitted, safeWidth, "");
  }
  const padding = Math.max(0, safeWidth - visibleWidth(fitted));
  return `${fitted}${" ".repeat(padding)}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function normalizeSingleVisibleLine(text: string): string {
  return text.replace(/\t/g, "   ").split("\n").join(" ");
}

function startsWithVisibleWhitespace(text: string): boolean {
  return /^\s/.test(stripAnsi(text));
}

function endsWithVisibleWhitespace(text: string): boolean {
  return /\s$/.test(stripAnsi(text));
}

function trimSingleLeadingVisibleWhitespace(text: string): string {
  let cursor = 0;
  let prefix = "";
  while (cursor < text.length) {
    const ansi = readAnsiSequence(text, cursor);
    if (!ansi) {
      break;
    }
    prefix += ansi.sequence;
    cursor = ansi.end;
  }

  const codePoint = text.codePointAt(cursor);
  if (codePoint === undefined) {
    return text;
  }

  const character = String.fromCodePoint(codePoint);
  return /\s/.test(character)
    ? `${prefix}${text.slice(cursor + character.length)}`
    : text;
}

function readAnsiSequence(text: string, start: number): { sequence: string; end: number } | undefined {
  if (text[start] !== "\x1b" || text[start + 1] !== "[") {
    return undefined;
  }

  let cursor = start + 2;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) {
      return {
        sequence: text.slice(start, cursor + 1),
        end: cursor + 1,
      };
    }
    cursor++;
  }

  return undefined;
}

function updateActiveAnsiPrefix(activePrefix: string, sequence: string): string {
  if (!sequence.endsWith("m")) {
    return activePrefix;
  }

  const codes = sequence.slice(2, -1).split(";").filter(Boolean);
  if (codes.length === 0 || codes.includes("0")) {
    return "";
  }
  if (codes.every((code) => code === "39" || code === "49")) {
    return "";
  }

  return sequence;
}

function splitAnsiTextAtVisibleWidth(
  text: string,
  width: number,
): { head: string; tail: string } {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0 || !text) {
    return { head: "", tail: text };
  }

  let visibleCount = 0;
  let cursor = 0;
  let head = "";
  let activePrefix = "";

  while (cursor < text.length && visibleCount < safeWidth) {
    const ansi = readAnsiSequence(text, cursor);
    if (ansi) {
      head += ansi.sequence;
      activePrefix = updateActiveAnsiPrefix(activePrefix, ansi.sequence);
      cursor = ansi.end;
      continue;
    }

    const codePoint = text.codePointAt(cursor);
    if (codePoint === undefined) {
      break;
    }

    const character = String.fromCodePoint(codePoint);
    const characterWidth = visibleWidth(character);
    if (visibleCount + characterWidth > safeWidth) {
      break;
    }

    head += character;
    visibleCount += characterWidth;
    cursor += character.length;
  }

  const tailRaw = text.slice(cursor);
  return {
    head,
    tail: tailRaw ? `${activePrefix}${tailRaw}` : "",
  };
}

function splitLogicalLines(text: string): string[] {
  const lines = text.replace(/\t/g, "   ").split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function rebalanceWrappedSegments(
  segments: string[],
  firstWidth: number,
  nextWidth: number,
): string[] {
  const balanced = [...segments];

  for (let index = 0; index < balanced.length - 1; index++) {
    const lineWidth = index === 0 ? firstWidth : nextWidth;
    const current = balanced[index] ?? "";
    const next = balanced[index + 1] ?? "";
    const separator =
      visibleWidth(current) > 0
        && !endsWithVisibleWhitespace(current)
        && !startsWithVisibleWhitespace(next)
        ? " "
        : "";
    const remainingWidth = lineWidth - visibleWidth(current) - visibleWidth(separator);
    if (remainingWidth <= 0) {
      continue;
    }

    const { head, tail } = splitAnsiTextAtVisibleWidth(next, remainingWidth);
    if (visibleWidth(head) === 0) {
      continue;
    }

    balanced[index] = `${current}${separator}${head}`;
    balanced[index + 1] = tail;
  }

  const visibleSegments = balanced.filter((segment) => visibleWidth(segment) > 0);
  return visibleSegments.length > 0 ? visibleSegments : [""];
}

function renderRawFrame(
  text: string,
  width: number,
  hangingIndent = "",
): string[] {
  if (!text || text.trim() === "") {
    return [];
  }

  const safeWidth = Math.max(1, width);
  const logicalLines = splitLogicalLines(text);
  const output: string[] = [];
  let isFirstVisualLine = true;

  for (const logicalLine of logicalLines) {
    const firstLineWidth = Math.max(
      1,
      safeWidth - (isFirstVisualLine ? 0 : visibleWidth(hangingIndent)),
    );
    const nextLineWidth = Math.max(1, safeWidth - visibleWidth(hangingIndent));
    const wrapped = wrapTextWithAnsi(logicalLine, nextLineWidth);
    const segments = rebalanceWrappedSegments(
      wrapped.length > 0 ? wrapped : [""],
      firstLineWidth,
      nextLineWidth,
    );

    for (const [segmentIndex, segment] of segments.entries()) {
      const prefix = isFirstVisualLine ? "" : hangingIndent;
      const previousSegment = segments[segmentIndex - 1] ?? "";
      const adjustedSegment = segmentIndex > 0 && !endsWithVisibleWhitespace(previousSegment)
        ? trimSingleLeadingVisibleWhitespace(segment)
        : segment;
      output.push(padLineToWidth(`${prefix}${adjustedSegment}`, safeWidth));
      isFirstVisualLine = false;
    }
  }

  return output;
}

function renderSingleLineFrame(
  frame: WrappedToolCallFrame,
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const text = frame.kind === "prefixed"
    ? `${frame.initialPrefix}${normalizeSingleVisibleLine(frame.content)}`
    : normalizeSingleVisibleLine(frame.text);
  if (!text || text.trim() === "") {
    return [];
  }
  return [padLineToWidth(text, safeWidth)];
}

function renderPrefixedFrame(
  frame: Extract<WrappedToolCallFrame, { kind: "prefixed" }>,
  width: number,
): string[] {
  if (!frame.content || frame.content.trim() === "") {
    return [];
  }

  const safeWidth = Math.max(1, width);
  const firstWidth = Math.max(1, safeWidth - visibleWidth(frame.initialPrefix));
  const nextWidth = Math.max(1, safeWidth - visibleWidth(frame.subsequentPrefix));
  const logicalLines = splitLogicalLines(frame.content);
  const output: string[] = [];
  let isFirstVisualLine = true;

  for (const logicalLine of logicalLines) {
    const lineFirstWidth = isFirstVisualLine ? firstWidth : nextWidth;
    const wrapped = wrapTextWithAnsi(logicalLine, nextWidth);
    const segments = rebalanceWrappedSegments(
      wrapped.length > 0 ? wrapped : [""],
      lineFirstWidth,
      nextWidth,
    );

    for (const [segmentIndex, segment] of segments.entries()) {
      const prefix = isFirstVisualLine ? frame.initialPrefix : frame.subsequentPrefix;
      const previousSegment = segments[segmentIndex - 1] ?? "";
      const adjustedSegment = segmentIndex > 0 && !endsWithVisibleWhitespace(previousSegment)
        ? trimSingleLeadingVisibleWhitespace(segment)
        : segment;
      output.push(padLineToWidth(`${prefix}${adjustedSegment}`, safeWidth));
      isFirstVisualLine = false;
    }
  }

  return output;
}

interface ToolStatusBulletStateCarrier {
  [TOOL_STATUS_BULLET_STATE_KEY]?: ToolStatusBulletAnimationState;
}

function toStateCarrier(
  value: unknown,
): ToolStatusBulletStateCarrier | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as ToolStatusBulletStateCarrier;
}

function getOrCreateAnimationState(
  value: unknown,
): ToolStatusBulletAnimationState | undefined {
  const carrier = toStateCarrier(value);
  if (!carrier) {
    return undefined;
  }

  const existing = carrier[TOOL_STATUS_BULLET_STATE_KEY];
  if (existing) {
    return existing;
  }

  const created: ToolStatusBulletAnimationState = { visible: true };
  carrier[TOOL_STATUS_BULLET_STATE_KEY] = created;
  return created;
}

function stopAnimation(
  state: ToolStatusBulletAnimationState | undefined,
): void {
  if (!state?.timer) {
    if (state) {
      state.visible = true;
    }
    return;
  }

  clearInterval(state.timer);
  state.timer = undefined;
  state.visible = true;
}

export function formatToolStatusBullet(
  theme: ToolStatusBulletTheme,
  status: ToolStatusBulletState,
  visible = true,
): string {
  if (status === "success") {
    return theme.fg("success", "•");
  }
  if (status === "error") {
    return theme.fg("error", "•");
  }
  return visible
    ? theme.fg("muted", "•")
    : theme.fg("dim", "•");
}

export function prefixToolStatusLine(
  line: string,
  theme: ToolStatusBulletTheme,
  status: Exclude<ToolStatusBulletState, "pending">,
): string {
  return `${TOOL_HISTORY_INDENT}${formatToolStatusBullet(theme, status)} ${line}`;
}

export function renderWrappedToolText(
  text: string,
  options: { hangingIndent?: string } = {},
): WrappedToolCallText {
  const component = new WrappedToolCallText();
  component.setFrame({
    kind: "raw",
    text,
    hangingIndent: options.hangingIndent,
  });
  return component;
}

export function setCompletedToolStatusLine(
  value: unknown,
  completedLine: string,
): boolean {
  const state = getOrCreateAnimationState(value);
  if (!state || state.completedLine === completedLine) {
    return false;
  }
  state.completedLine = completedLine;
  return true;
}

export function clearCompletedToolStatusLine(
  value: unknown,
): void {
  const state = getOrCreateAnimationState(value);
  if (state) {
    state.completedLine = undefined;
    state.completedLineInvalidateScheduled = false;
  }
}

export function scheduleCompletedToolStatusInvalidate(
  value: unknown,
  invalidate: (() => void) | undefined,
): void {
  const state = getOrCreateAnimationState(value);
  if (!state || !invalidate || state.completedLineInvalidateScheduled) {
    return;
  }

  state.completedLineInvalidateScheduled = true;
  queueMicrotask(() => {
    state.completedLineInvalidateScheduled = false;
    invalidate();
  });
}

export function renderBlinkingToolCall(
  lineBuilder: () => string,
  theme: ToolStatusBulletTheme,
  context: ToolStatusBulletCallContextLike,
  options: { showPendingWhenStarted?: boolean; showPendingWhilePartial?: boolean } = {},
): WrappedToolCallText {
  const text = context.lastComponent instanceof WrappedToolCallText
    ? context.lastComponent
    : new WrappedToolCallText();
  const state = getOrCreateAnimationState(context.state);
  const shouldBlink = context.executionStarted && context.isPartial;
  const shouldShowPendingWhilePartial =
    options.showPendingWhilePartial === true &&
    context.isPartial &&
    !state?.completedLine;
  const shouldShowPending =
    shouldBlink ||
    shouldShowPendingWhilePartial ||
    (context.executionStarted && options.showPendingWhenStarted === true && !state?.completedLine);

  const buildFrame = (visible: boolean): WrappedToolCallFrame => {
    const line = lineBuilder();
    if (!shouldShowPending && state?.completedLine) {
      return {
        kind: "raw",
        text: state.completedLine,
        hangingIndent: " ".repeat(visibleWidth(`${TOOL_HISTORY_INDENT}• `)),
        singleLine: true,
      };
    }
    if (!shouldShowPending) {
      return {
        kind: "prefixed",
        content: line,
        initialPrefix: TOOL_HISTORY_INDENT,
        subsequentPrefix: TOOL_HISTORY_INDENT,
        singleLine: true,
      };
    }
    return {
      kind: "prefixed",
      content: line,
      initialPrefix: `${TOOL_HISTORY_INDENT}${formatToolStatusBullet(theme, "pending", visible)} `,
      subsequentPrefix: " ".repeat(visibleWidth(`${TOOL_HISTORY_INDENT}• `)),
      singleLine: true,
    };
  };

  if (shouldBlink && state) {
    if (!state.timer) {
      state.timer = setInterval(() => {
        state.visible = !state.visible;
        text.setFrame(buildFrame(state.visible));
        context.invalidate();
      }, TOOL_STATUS_BULLET_INTERVAL_MS);
      state.timer.unref?.();
    }
  } else {
    stopAnimation(state);
  }

  text.setFrame(buildFrame(state?.visible ?? true));
  return text;
}
