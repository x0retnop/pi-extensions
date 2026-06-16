import { type Static, Type } from "typebox";

import type { EditItem } from "./types.js";

const editItemSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "File path for this edit (required when editing multiple files)" }),
  ),
  oldText: Type.String({ description: "Exact text to find" }),
  newText: Type.String({ description: "Replacement text" }),
  replaceAll: Type.Optional(
    Type.Boolean({ description: "Replace every occurrence instead of requiring uniqueness" }),
  ),
});

const multiItemSchema = Type.Object({
  path: Type.String({ description: "File path for this edit" }),
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
    Type.String({ description: "Target file when all edits are in the same file" }),
  ),
  file_path: Type.Optional(
    Type.String({ description: "Alias for path (some models send file_path)" }),
  ),
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
  if (typeof args.path === "string" && args.path) return args.path;
  if (typeof args.file_path === "string" && args.file_path) return args.file_path;
  return undefined;
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
  return multi.filter(
    (m) =>
      m &&
      typeof m === "object" &&
      typeof (m as RawEdit).path === "string" &&
      typeof (m as RawEdit).oldText === "string" &&
      typeof (m as RawEdit).newText === "string",
  ) as RawEdit[];
}

export function prepareArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") {
    return (input ?? {}) as EditToolInput;
  }

  const raw = input as Record<string, unknown>;
  const args: Record<string, unknown> = { ...raw };

  if (typeof args.file_path === "string" && typeof args.path !== "string") {
    args.path = args.file_path;
  }

  const parsedEdits = parseEditsJsonString(args.edits);
  if (parsedEdits) args.edits = parsedEdits;

  let edits = Array.isArray(args.edits) ? [...(args.edits as RawEdit[])] : [];

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

  if (edits.length > 0) args.edits = edits;
  else delete args.edits;

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
      throw new Error(
        `edits[${i}] needs a path — set top-level path or path on each edit for multi-file.`,
      );
    }
    const item = asEditItem(path, e);
    if (!item) {
      throw new Error(`edits[${i}] needs oldText and newText strings.`);
    }
    items.push(item);
  }

  return items;
}