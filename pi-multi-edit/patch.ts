import { isAbsolute, resolve as resolvePath } from "path";

import { generateDiffString } from "./diff.js";
import type { Hunk, PatchOperation, PatchOpResult, Workspace } from "./types.js";

class LineCursor {
  private pos = 0;
  constructor(private readonly lines: readonly string[]) {}

  peek(): string | undefined {
    return this.lines[this.pos];
  }

  next(): string | undefined {
    return this.lines[this.pos++];
  }

  hasMore(): boolean {
    return this.pos < this.lines.length;
  }

  skipWhile(pred: (line: string) => boolean): number {
    let count = 0;
    while (this.hasMore() && pred(this.peek()!)) {
      this.pos++;
      count++;
    }
    return count;
  }
}

const DIRECTIVE_BEGIN = "*** Begin Patch";
const DIRECTIVE_END = "*** End Patch";
const DIRECTIVE_ADD = "*** Add File: ";
const DIRECTIVE_DELETE = "*** Delete File: ";
const DIRECTIVE_UPDATE = "*** Update File: ";
const DIRECTIVE_MOVE = "*** Move to: ";

const isBlank = (line: string): boolean => line.trim() === "";
const isDirective = (line: string): boolean => line.trimEnd().startsWith("*** ");

export function parsePatch(patchText: string): PatchOperation[] {
  const normalized = patchText.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    throw new Error("Patch is empty or invalid");
  }

  const lines = normalized.split("\n");
  if (lines[0].trim() !== DIRECTIVE_BEGIN) {
    throw new Error(`The first line of the patch must be '${DIRECTIVE_BEGIN}'`);
  }
  if (lines[lines.length - 1].trim() !== DIRECTIVE_END) {
    throw new Error(`The last line of the patch must be '${DIRECTIVE_END}'`);
  }

  const cursor = new LineCursor(lines.slice(1, -1));
  const operations: PatchOperation[] = [];

  while (cursor.hasMore()) {
    cursor.skipWhile(isBlank);
    if (!cursor.hasMore()) break;

    const header = cursor.next()!.trimEnd();

    if (header.startsWith(DIRECTIVE_ADD)) {
      operations.push(parseAddFile(header.slice(DIRECTIVE_ADD.length), cursor));
      continue;
    }
    if (header.startsWith(DIRECTIVE_DELETE)) {
      operations.push({ kind: "delete", path: header.slice(DIRECTIVE_DELETE.length) });
      continue;
    }
    if (header.startsWith(DIRECTIVE_UPDATE)) {
      operations.push(parseUpdateFile(header.slice(DIRECTIVE_UPDATE.length), cursor));
      continue;
    }

    throw new Error(
      `'${header}' is not a valid hunk header. Valid headers: '${DIRECTIVE_ADD.trim()}', '${DIRECTIVE_DELETE.trim()}', '${DIRECTIVE_UPDATE.trim()}'`,
    );
  }

  return operations;
}

function parseAddFile(path: string, cursor: LineCursor): PatchOperation {
  const bodyLines: string[] = [];
  while (cursor.hasMore()) {
    const line = cursor.peek()!;
    if (isDirective(line)) break;
    cursor.next();
    if (!line.startsWith("+")) {
      throw new Error(`Invalid add-file line '${line}'. Add-file lines must start with '+'`);
    }
    bodyLines.push(line.slice(1));
  }
  const contents = bodyLines.length > 0 ? `${bodyLines.join("\n")}\n` : "";
  return { kind: "add", path, contents };
}

function parseUpdateFile(path: string, cursor: LineCursor): PatchOperation {
  const lookahead = cursor.peek();
  if (lookahead !== undefined && lookahead.trimEnd().startsWith(DIRECTIVE_MOVE)) {
    throw new Error("Patch move operations (*** Move to:) are not supported.");
  }

  const hunks: Hunk[] = [];
  while (cursor.hasMore()) {
    cursor.skipWhile(isBlank);
    if (!cursor.hasMore()) break;
    const line = cursor.peek()!;
    if (isDirective(line)) break;
    hunks.push(parseHunk(path, cursor));
  }

  if (hunks.length === 0) {
    throw new Error(`Update file hunk for path '${path}' is empty`);
  }

  return { kind: "update", path, hunks };
}

function parseHunk(path: string, cursor: LineCursor): Hunk {
  const header = cursor.next();
  if (header === undefined) {
    throw new Error(`Expected @@ hunk header in '${path}', got end of patch`);
  }

  const trimmed = header.trimEnd();
  let contextPrefix: string | undefined;
  if (trimmed === "@@") {
    contextPrefix = undefined;
  } else if (trimmed.startsWith("@@ ")) {
    contextPrefix = trimmed.slice(3);
  } else {
    throw new Error(`Expected update hunk to start with @@ context marker, got: '${header}'`);
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];

  while (cursor.hasMore()) {
    const raw = cursor.peek()!;
    const trimEnd = raw.trimEnd();

    if (trimEnd.startsWith("@@") || isDirective(raw)) break;
    cursor.next();

    if (raw.length === 0) {
      oldLines.push("");
      newLines.push("");
      continue;
    }

    const marker = raw[0];
    const body = raw.slice(1);

    if (marker === " ") {
      oldLines.push(body);
      newLines.push(body);
    } else if (marker === "-") {
      oldLines.push(body);
    } else if (marker === "+") {
      newLines.push(body);
    } else {
      throw new Error(
        `Unexpected line found in update hunk for '${path}': '${raw}'. Every line should start with ' ', '+', or '-'.`,
      );
    }
  }

  if (oldLines.length === 0 && newLines.length === 0) {
    throw new Error(`Update hunk for '${path}' does not contain any lines`);
  }

  return {
    contextPrefix,
    oldBlock: oldLines.join("\n"),
    newBlock: newLines.join("\n"),
  };
}

function findBlock(
  haystack: string,
  needle: string,
  offset: number,
): { pos: number; matchLength: number } | undefined {
  const exact = haystack.indexOf(needle, offset);
  if (exact !== -1) return { pos: exact, matchLength: needle.length };

  const trimLine = (s: string) => s.split("\n").map((l) => l.trimEnd()).join("\n");
  const normNeedle = trimLine(needle);
  const normHaystack = trimLine(haystack);
  if (normNeedle === needle && normHaystack === haystack) return undefined;

  const normPos = normHaystack.indexOf(normNeedle, offset);
  if (normPos === -1) return undefined;

  const normPrefix = normHaystack.slice(0, normPos);
  const startLineIdx = normPrefix.split("\n").length - 1;

  const origLines = haystack.split("\n");
  let realPos = 0;
  for (let i = 0; i < startLineIdx; i++) realPos += origLines[i].length + 1;

  const matchedLineCount = normNeedle.split("\n").length;
  let realEnd = realPos;
  for (let i = startLineIdx; i < startLineIdx + matchedLineCount; i++) {
    realEnd += origLines[i].length + 1;
  }
  realEnd--;
  if (needle.endsWith("\n") && realEnd + 1 <= haystack.length) realEnd++;

  return { pos: realPos, matchLength: realEnd - realPos };
}

function applyHunks(filePath: string, content: string, hunks: Hunk[]): string {
  let result = content;
  let cursor = 0;

  for (const hunk of hunks) {
    let searchFrom = cursor;

    if (hunk.contextPrefix !== undefined) {
      const ctxMatch = findBlock(result, hunk.contextPrefix, searchFrom);
      if (ctxMatch === undefined) {
        throw new Error(`Failed to find context '${hunk.contextPrefix}' in ${filePath}`);
      }
      searchFrom = ctxMatch.pos + ctxMatch.matchLength;
    }

    if (hunk.oldBlock === "") {
      const insertAt = hunk.contextPrefix !== undefined ? searchFrom : result.length;
      const needsNewline = insertAt > 0 && result[insertAt - 1] !== "\n";
      const prefix = needsNewline ? "\n" : "";
      result = result.slice(0, insertAt) + prefix + hunk.newBlock + result.slice(insertAt);
      cursor = insertAt + prefix.length + hunk.newBlock.length;
      continue;
    }

    const match = findBlock(result, hunk.oldBlock, searchFrom);
    if (match === undefined) {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${hunk.oldBlock}`);
    }

    result = result.slice(0, match.pos) + hunk.newBlock + result.slice(match.pos + match.matchLength);
    cursor = match.pos + hunk.newBlock.length;
  }

  if (!result.endsWith("\n")) {
    result = `${result}\n`;
  }

  return result;
}

function resolvePatchPath(cwd: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("Patch path cannot be empty");
  }
  return isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(cwd, trimmed);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

interface PatchSnapshot {
  path: string;
  existed: boolean;
  content: string;
}

async function rollbackPatchSnapshots(
  snapshots: Map<string, PatchSnapshot>,
  workspace: Workspace,
): Promise<void> {
  await Promise.all(
    Array.from(snapshots, ([absPath, snapshot]) => {
      if (snapshot.existed) {
        return workspace.writeText(absPath, snapshot.content).catch(() => {});
      }
      return workspace.deleteFile(absPath).catch(() => {});
    }),
  );
}

export async function applyPatchOperations(
  ops: PatchOperation[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
  options?: { collectDiff?: boolean; rollbackOnError?: boolean },
): Promise<PatchOpResult[]> {
  const results: PatchOpResult[] = [];
  const collectDiff = options?.collectDiff ?? false;
  const rollbackOnError = options?.rollbackOnError ?? false;
  const snapshots = new Map<string, PatchSnapshot>();

  for (const op of ops) {
    if (signal?.aborted) {
      if (rollbackOnError) {
        await rollbackPatchSnapshots(snapshots, workspace);
      }
      throw new Error("Operation aborted");
    }

    try {
      switch (op.kind) {
        case "add": {
          const abs = resolvePatchPath(cwd, op.path);
          const existed = await workspace.exists(abs);
          const oldText = collectDiff && existed ? await workspace.readText(abs) : "";
          if (rollbackOnError) {
            snapshots.set(abs, { path: abs, existed, content: oldText });
          }
          const newText = ensureTrailingNewline(op.contents);
          await workspace.writeText(abs, newText);
          results.push(buildOpResult(op.path, `Added file ${op.path}.`, oldText, newText, collectDiff));
          break;
        }
        case "delete": {
          const abs = resolvePatchPath(cwd, op.path);
          if (!(await workspace.exists(abs))) {
            throw new Error(`Failed to delete ${op.path}: file does not exist`);
          }
          const oldText = collectDiff ? await workspace.readText(abs) : "";
          if (rollbackOnError) {
            snapshots.set(abs, { path: abs, existed: true, content: oldText });
          }
          await workspace.deleteFile(abs);
          results.push(buildOpResult(op.path, `Deleted file ${op.path}.`, oldText, "", collectDiff));
          break;
        }
        case "update": {
          const abs = resolvePatchPath(cwd, op.path);
          const sourceText = await workspace.readText(abs);
          if (rollbackOnError) {
            snapshots.set(abs, { path: abs, existed: true, content: sourceText });
          }
          const updated = applyHunks(op.path, sourceText, op.hunks);
          await workspace.writeText(abs, updated);
          results.push(buildOpResult(op.path, `Updated ${op.path}.`, sourceText, updated, collectDiff));
          break;
        }
      }
    } catch (err) {
      if (rollbackOnError) {
        await rollbackPatchSnapshots(snapshots, workspace);
      }
      throw err;
    }
  }

  return results;
}

function buildOpResult(
  path: string,
  message: string,
  oldText: string,
  newText: string,
  collectDiff: boolean,
): PatchOpResult {
  const result: PatchOpResult = { path, message };
  if (collectDiff) {
    const { diff, firstChangedLine } = generateDiffString(oldText, newText);
    result.diff = diff;
    result.firstChangedLine = firstChangedLine;
  }
  return result;
}
