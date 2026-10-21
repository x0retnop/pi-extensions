import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MAX_BYTES = 10 * 1024; // 10KB
export const DEFAULT_MAX_LINES = 100;
export const ABSOLUTE_MAX_BYTES = 50 * 1024; // 50KB hard cap

export interface OutputGuardOptions {
  /** Maximum bytes to return inline (default: 10KB, hard cap: 50KB). */
  maxBytes?: number;
  /** Maximum lines to return inline (default: 100). */
  maxLines?: number;
  /** Prefix for the temp file name. */
  tempFilePrefix?: string;
}

export interface OutputGuardResult {
  text: string;
  details: {
    truncated?: boolean;
    truncatedBy?: "bytes" | "lines" | null;
    totalBytes: number;
    totalLines: number;
    outputBytes: number;
    outputLines: number;
    fullOutputPath?: string;
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Guard tool output size: keep a bounded tail inline, spill the full output
 * to a temp file when it exceeds limits. Mirrors the behavior of Pi's built-in
 * bash/read tools so big outputs do not blow up the context window.
 */
export async function guardOutput(
  output: string,
  options: OutputGuardOptions = {},
): Promise<OutputGuardResult> {
  const maxBytes = Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, ABSOLUTE_MAX_BYTES);
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const prefix = options.tempFilePrefix ?? "pi-output";

  const totalBytes = byteLength(output);
  const lines = splitLines(output);
  const totalLines = lines.length;

  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return {
      text: output,
      details: {
        truncated: false,
        truncatedBy: null,
        totalBytes,
        totalLines,
        outputBytes: totalBytes,
        outputLines: totalLines,
      },
    };
  }

  // Work backwards from the tail, keeping complete lines.
  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "bytes" | "lines" = "lines";

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const line = lines[i];
    const lineBytes = byteLength(line) + (outputLinesArr.length > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const content = outputLinesArr.join("\n");
  const contentBytes = byteLength(content);
  const startLine = totalLines - outputLinesArr.length + 1;
  const endLine = totalLines;

  const tmpDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const fullOutputPath = join(tmpDir, "full-output.log");
  await writeFile(fullOutputPath, output, "utf-8");

  const summary =
    `[Showing lines ${startLine}-${endLine} of ${totalLines} ` +
    `(${formatSize(contentBytes)} of ${formatSize(totalBytes)}). ` +
    `Full output: ${fullOutputPath}. ` +
    `Hint: filter the output in your script, or pass max_output to raise the inline limit (max ${formatSize(ABSOLUTE_MAX_BYTES)}).]`;

  return {
    text: `${content}\n\n${summary}`,
    details: {
      truncated: true,
      truncatedBy,
      totalBytes,
      totalLines,
      outputBytes: contentBytes,
      outputLines: outputLinesArr.length,
      fullOutputPath,
    },
  };
}

/**
 * Best-effort cleanup of a temp directory created by guardOutput.
 */
export async function cleanupOutputPath(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    const dir = filePath.replace(/[\\/]full-output\.log$/, "");
    await rm(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}
