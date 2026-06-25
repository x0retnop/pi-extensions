import { type Static, Type } from "typebox";

import type { EditItem } from "./types.js";

/** Keys models sometimes send instead of `path`. Kept only for normalization; schemas expose `path`. */
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

/** Remove every path alias except the canonical `path` key. */
function stripPathAliases(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "path" && PATH_KEYS.includes(k as typeof PATH_KEYS[number])) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

const itemPathProp = {
  path: Type.Optional(Type.String({ description: "File path for this edit" })),
};

const editItemSchema = Type.Object(
  {
    ...itemPathProp,
    oldText: Type.String({
      description:
        "Exact text to find. MUST match whitespace, tabs, quotes, and trailing spaces exactly.",
    }),
    newText: Type.String({
      description:
        'Replacement text. Use "" (empty string) to delete the matched oldText block.',
    }),
    replaceAll: Type.Optional(
      Type.Boolean({
        description: "Replace every occurrence instead of requiring uniqueness",
      }),
    ),
  },
  { additionalProperties: false },
);

const multiItemSchema = Type.Object(
  {
    path: Type.String(),
    oldText: Type.String(),
    newText: Type.String(),
    replaceAll: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/**
 * Input schema. `path` is optional at validation time because models sometimes
 * place it inside `edits[]` or use aliases; `prepareArguments` normalizes to
 * a valid shape before `execute()` is called.
 */
export const editParameters = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description:
          "Target file for single-file or batch edits (relative or absolute). Copy from your last read.",
      }),
    ),
    file_path: Type.Optional(
      Type.String({ description: "Alias for path — prefer top-level path" }),
    ),
    oldText: Type.Optional(
      Type.String({ description: "Single-edit shorthand — prefer edits[].oldText" }),
    ),
    newText: Type.Optional(
      Type.String({ description: "Single-edit shorthand — prefer edits[].newText" }),
    ),
    replaceAll: Type.Optional(
      Type.Boolean({ description: "Single-edit shorthand for replaceAll" }),
    ),
    partialApply: Type.Optional(
      Type.Boolean({
        description:
          "When true, apply edits that match and report failures separately instead of aborting the whole batch.",
      }),
    ),
    edits: Type.Optional(
      Type.Array(editItemSchema, {
        description:
          "Batch edits in ONE file. Requires top-level path. Each item is {oldText, newText}.",
      }),
    ),
    multi: Type.Optional(
      Type.Array(multiItemSchema, {
        description:
          "Deprecated multi-file batch format. Prefer separate `edit` calls or per-item paths in `edits`.",
      }),
    ),
  },
  { additionalProperties: false },
);

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
  const top = resolvePathFromRecord(args);
  if (top) return top;

  // Some callers put path inside every edits[] item; if all items share one
  // path, treat it as the top-level path.
  const editsArr = Array.isArray(args.edits) ? args.edits : undefined;
  if (editsArr && editsArr.length > 0) {
    const paths = editsArr
      .map((e) =>
        e && typeof e === "object"
          ? resolvePathFromRecord(e as Record<string, unknown>)
          : undefined,
      )
      .filter((p): p is string => !!p);
    const unique = [...new Set(paths)];
    if (unique.length === 1) return unique[0];
  }
  return undefined;
}

function normalizeEditPaths(edits: RawEdit[]): RawEdit[] {
  return edits.map((e) => {
    if (!e || typeof e !== "object") return e;
    const rec = e as Record<string, unknown>;
    const p = resolvePathFromRecord(rec);
    const cleaned = stripPathAliases(rec);
    if (!p) return cleaned as RawEdit;
    return { ...cleaned, path: p };
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
      "Missing path — add top-level path (copy from the file you just read). " +
      'Example: {"path":"tests/test_foo.py","edits":[{"oldText":"...","newText":"..."}]}'
    );
  }
  if (index === 0 && editCount > 1) {
    return (
      "Missing path. Same-file batch: set top-level path once. " +
      'Example: {"path":"src/foo.py","edits":[{"oldText":"a","newText":"b"},{"oldText":"c","newText":"d"}]}'
    );
  }
  return `edits[${index}] needs path — set top-level path for the file.`;
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
  let args: Record<string, unknown> = { ...raw };

  const topPath = resolvePathFromRecord(args);
  if (topPath) args.path = topPath;
  args = stripPathAliases(args);

  const parsedEdits = parseEditsJsonString(args.edits);
  if (parsedEdits) args.edits = parsedEdits;

  let edits = Array.isArray(args.edits) ? [...(args.edits as RawEdit[])] : [];
  edits = normalizeEditPaths(edits);

  const fromMulti = normalizeMulti(args.multi);

  // Mutually exclusive: keep the explicit choice the model made.
  if (edits.length > 0 && fromMulti.length > 0) {
    throw new Error(
      "Cannot use both `edits` and `multi` in the same call. " +
      "Use `edits` for batch edits.",
    );
  }

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

export function parseEdits(params: Record<string, unknown>): { edits: EditItem[]; partialApply: boolean } {
  const normalized = prepareArguments(params);
  const topPath = resolveTopPath(normalized as Record<string, unknown>);
  const editsArr = Array.isArray(normalized.edits) ? normalized.edits : null;

  if (!editsArr || editsArr.length === 0) {
    throw new Error(
      "No edits to apply. Send edits:[{oldText,newText}], or top-level oldText+newText+path.",
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

  return { edits: items, partialApply: normalized.partialApply === true };
}
