import { type Static, Type } from "typebox";

import type { EditItem } from "./types.js";

/** Keys models use instead of path (native edit uses path; read/write use path too). */
export const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filepath",
  "file",
  "filename",
] as const;

export function resolvePathFromRecord(
  obj: Record<string, unknown> | undefined,
): string | undefined {
  if (!obj) return undefined;
  for (const key of PATH_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

const pathAliasProps = {
  path: Type.Optional(Type.String({ description: "File path for this edit" })),
  file_path: Type.Optional(Type.String({ description: "Alias for path" })),
  filePath: Type.Optional(Type.String({ description: "Alias for path" })),
  filepath: Type.Optional(Type.String({ description: "Alias for path" })),
  file: Type.Optional(Type.String({ description: "Alias for path" })),
  filename: Type.Optional(Type.String({ description: "Alias for path" })),
};

const editItemSchema = Type.Object({
  ...pathAliasProps,
  oldText: Type.String({ description: "Exact text to find" }),
  newText: Type.String({ description: "Replacement text" }),
  replaceAll: Type.Optional(
    Type.Boolean({ description: "Replace every occurrence instead of requiring uniqueness" }),
  ),
});

const multiItemSchema = Type.Object({
  ...pathAliasProps,
  oldText: Type.String({ description: "Exact text to find" }),
  newText: Type.String({ description: "Replacement text" }),
  replaceAll: Type.Optional(
    Type.Boolean({ description: "Replace every occurrence instead of requiring uniqueness" }),
  ),
});

/**
 * Permissive input schema: provider JSON-schema validation must accept every shape
 * models actually send. prepareArguments normalizes to edits[] before execute().
 */
export const editParameters = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Target file (relative or absolute). REQUIRED for single-file edits unless each edits[] item has path.",
    }),
  ),
  file_path: Type.Optional(Type.String({ description: "Alias for path" })),
  filePath: Type.Optional(Type.String({ description: "Alias for path" })),
  filepath: Type.Optional(Type.String({ description: "Alias for path" })),
  file: Type.Optional(Type.String({ description: "Alias for path" })),
  filename: Type.Optional(Type.String({ description: "Alias for path" })),
  oldText: Type.Optional(
    Type.String({ description: "Single-edit shorthand — prefer edits[].oldText" }),
  ),
  newText: Type.Optional(
    Type.String({ description: "Single-edit shorthand — prefer edits[].newText" }),
  ),
  replaceAll: Type.Optional(Type.Boolean({ description: "Single-edit shorthand for replaceAll" })),
  edits: Type.Optional(
    Type.Array(editItemSchema, {
      description:
        "Preferred: one or more replacements. Each oldText matches the original file. Multi-file: set path on each item.",
    }),
  ),
  multi: Type.Optional(
    Type.Array(multiItemSchema, {
      description: "Legacy multi-file shorthand — prefer edits[] with path per item.",
    }),
  ),
});

export type EditToolInput = Static<typeof editParameters>;

type RawEdit = {
  path?: unknown;
  oldText?: unknown;
  newText?: unknown;
  replaceAll?: unknown;
};

function asEditItem(path: string, e: RawEdit): EditItem | undefined {
  if (typeof e.oldText !== "string" || typeof e.newText !== "string") return undefined;
  return {
    path,
    oldText: e.oldText,
    newText: e.newText,
    replaceAll: e.replaceAll === true,
  };
}

function resolveTopPath(args: Record<string, unknown>): string | undefined {
  return resolvePathFromRecord(args);
}

function normalizeEditPaths(edits: RawEdit[]): RawEdit[] {
  return edits.map((e) => {
    if (!e || typeof e !== "object") return e;
    const rec = e as Record<string, unknown>;
    const p = resolvePathFromRecord(rec);
    if (!p) return e;
    return { ...e, path: p };
  });
}

function hoistSharedFilePath(args: Record<string, unknown>, edits: RawEdit[]): void {
  if (resolveTopPath(args)) return;

  const paths = edits
    .map((e) => (e && typeof e === "object" ? resolvePathFromRecord(e as Record<string, unknown>) : undefined))
    .filter((p): p is string => !!p);
  const unique = [...new Set(paths)];
  if (unique.length === 1) args.path = unique[0];
}

function pathMissingMessage(index: number, editCount: number): string {
  if (editCount === 1) {
    return (
      "Missing path. Single-file edit needs top-level path (or file/file_path). " +
      'Example: {"path":"src/foo.py","edits":[{"oldText":"...","newText":"..."}]}'
    );
  }
  if (index === 0 && editCount > 1) {
    return (
      "Missing path. Same-file batch: set top-level path once. " +
      'Example: {"path":"src/foo.py","edits":[{"oldText":"a","newText":"b"},{"oldText":"c","newText":"d"}]}'
    );
  }
  return `edits[${index}] needs path — set top-level path for one file, or path on each edit for multi-file.`;
}

function parseEditsJsonString(value: unknown): RawEdit[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as RawEdit[]) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMulti(multi: unknown): RawEdit[] {
  if (!Array.isArray(multi)) return [];
  const out: RawEdit[] = [];
  for (const m of multi) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const path = resolvePathFromRecord(rec);
    if (
      !path ||
      typeof rec.oldText !== "string" ||
      typeof rec.newText !== "string"
    ) {
      continue;
    }
    out.push({
      path,
      oldText: rec.oldText,
      newText: rec.newText,
      replaceAll: rec.replaceAll === true ? true : undefined,
    });
  }
  return out;
}

export function prepareArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") {
    return (input ?? {}) as EditToolInput;
  }

  const raw = input as Record<string, unknown>;
  const args: Record<string, unknown> = { ...raw };

  const topPath = resolvePathFromRecord(args);
  if (topPath) args.path = topPath;

  const parsedEdits = parseEditsJsonString(args.edits);
  if (parsedEdits) args.edits = parsedEdits;

  let edits = Array.isArray(args.edits) ? [...(args.edits as RawEdit[])] : [];
  edits = normalizeEditPaths(edits);

  const fromMulti = normalizeMulti(args.multi);
  if (fromMulti.length > 0) {
    edits.push(...fromMulti);
    delete args.multi;
  }

  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    edits.push({
      oldText: args.oldText,
      newText: args.newText,
      replaceAll: args.replaceAll === true ? true : undefined,
    });
    delete args.oldText;
    delete args.newText;
    delete args.replaceAll;
  }

  if (edits.length > 0) {
    hoistSharedFilePath(args, edits);
    args.edits = normalizeEditPaths(edits);
  } else {
    delete args.edits;
  }

  delete args.multi;
  delete args.oldText;
  delete args.newText;
  delete args.replaceAll;

  return args as EditToolInput;
}

export function parseEdits(params: Record<string, unknown>): EditItem[] {
  const normalized = prepareArguments(params);
  const topPath = resolveTopPath(normalized as Record<string, unknown>);
  const editsArr = Array.isArray(normalized.edits) ? normalized.edits : null;

  if (!editsArr || editsArr.length === 0) {
    throw new Error(
      "No edits to apply. Send edits:[{oldText,newText}], or top-level oldText+newText+path, or multi:[{path,oldText,newText}].",
    );
  }

  const items: EditItem[] = [];
  for (let i = 0; i < editsArr.length; i++) {
    const e = editsArr[i];
    if (!e || typeof e !== "object") {
      throw new Error(`edits[${i}] is invalid.`);
    }
    const path = typeof e.path === "string" && e.path ? e.path : topPath;
    if (!path) {
      throw new Error(pathMissingMessage(i, editsArr.length));
    }
    const item = asEditItem(path, e);
    if (!item) {
      throw new Error(`edits[${i}] needs oldText and newText strings.`);
    }
    items.push(item);
  }

  return items;
}